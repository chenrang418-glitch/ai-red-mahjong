import { attackRangeCovers } from '../../engine/ask-use-slash'
import { cardCategoryOfName } from '../../engine/damage-provenance'
import { drawCards } from '../../engine/draw'
import { giveCards } from '../../engine/hand-transfer'
import { movePickedCard } from '../../engine/card-pick'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { effectiveCardName } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 陈宫（一将成名 2011 经典）。
 *
 * 【明策】：出牌阶段限一次，你可以将一张【杀】或装备牌交给一名其他角色，
 *          然后其选择一项：视为对你选择的、其攻击范围内的另一名角色使用一张【杀】；
 *          或摸一张牌。
 * 【智迟】：锁定技，你于回合外受到伤害后，直到当前回合结束，
 *          【杀】和非延时锦囊牌对你无效。
 *
 * 六处最容易做错的：
 *
 * 1. **先给牌，再看攻击范围。** 交出去的装备**不会自动装备**，
 *    所以 A 的攻击范围通常不因此改变；但顺序仍然要对，别提前锁定 B。
 * 2. **选哪一项由 A 决定**，不是陈宫替他选。
 * 3. **虚拟【杀】的使用者和伤害来源都是 A**，完整经过求闪、无双、享乐、
 *    藤甲、铁骑这一整条管线；它**没有实体子牌**，刚收到的那张【杀】
 *    仍然留在 A 手里。
 * 4. **智迟要真的受到过伤害**：被防止的、被换成失去体力的都不算。
 * 5. **智迟是「效果无效」不是「不能指定目标」**：别人照常可以选他当目标，
 *    只是效果不产生，所以也不问他要【闪】。
 * 6. **智迟到当前回合结束就失效**，不是「到陈宫的下个回合」。
 *    记的是触发时的回合序号，序号一变它自然过期——不需要另外注册清理。
 */

const MINGCE = 'mingce'
const ZHICHI = 'zhichi'
const MINGCE_ACTION = 'mingce-invoke'

/** 智迟生效于哪一个回合。存回合序号而不是布尔值，回合一换自然过期。 */
const ZHICHI_TURN = 'zhichi-turn'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 明策 ───────────────────────────────

/**
 * 明策能交出去的牌：手牌里的【杀】或装备牌，加上**装备区里的装备**。
 *
 * 判定区不算——那些牌不是「他的牌」，是挂在他身上的效果。
 * 和【举荐】同一口径。
 */
function mingceCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const fromHand = owner.zones.hand.filter((cardId) => {
    const name = effectiveCardName(state, cardId)
    if (name === '杀') return true
    return state.cards[cardId]?.category === 'equipment'
  })
  const equipped = Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => !!cardId)
  return [...fromHand, ...equipped]
}

/** `userId` 的攻击范围里有哪些**别的**角色。陈宫自己也算在内。 */
function slashTargetsFor(state: SanguoshaState, userId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== userId)
    .filter((candidate) => attackRangeCovers(state, userId, candidate.id))
    .map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: MINGCE,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisTurn(state, ownerId, MINGCE)) return []
    if (mingceCards(state, ownerId).length === 0) return []
    if (state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).length === 0) return []
    return [{ id: MINGCE_ACTION, label: '明策：将一张【杀】或装备牌交给一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== MINGCE_ACTION) return
    const cardIds = mingceCards(host.state, ownerId)
    if (cardIds.length === 0) return
    host.askSkill({
      skillId: MINGCE, ownerId, step: 'cost',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【明策】：选择一张【杀】或装备牌交给一名其他角色',
        timeoutMs: 25_000,
        // 取消不消耗「出牌阶段限一次」
        optional: true, purpose: 'skill',
        cardIds, hiddenCardSlots: [],
        min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'cost') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner?.alive) return
      // 落地前重新验一次：发问期间这张牌可能已经被别的效果拿走了
      if (!mingceCards(host.state, ownerId).includes(cardId)) return
      const candidateIds = host.state.players
        .filter((candidate) => candidate.alive && candidate.id !== ownerId)
        .map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: MINGCE, ownerId, step: 'target', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【明策】：把这张牌交给哪名角色',
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const cardId = resolution.data.cardId as CardId
      const [userId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const user = userId ? playerOf(host.state, userId) : undefined
      if (!owner?.alive || !user?.alive) return
      if (!mingceCards(host.state, ownerId).includes(cardId)) return
      markUsedThisTurn(host.state, ownerId, MINGCE)

      /*
       * **真的把牌交过去。**
       *
       * 手牌走「交给」（不路过弃牌堆）；装备区的那张先离场再交给，
       * 白银狮子的回血、枭姬、旋风都在统一入口里。
       * 交过去的装备**进的是手牌**，不会自动装备。
       */
      const fromHand = user && owner.zones.hand.includes(cardId)
      if (fromHand) {
        if (giveCards(host as never, ownerId, userId!, [cardId], MINGCE).length === 0) return
      } else {
        if (!movePickedCard(host as never, ownerId, cardId, { kind: 'hand', playerId: userId! })) return
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: MINGCE }, { targetId: ownerId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: userId!, cardIds: [cardId], reason: MINGCE }, { targetId: userId!, cardIds: [cardId] })
      }
      host.dispatch('SkillActivated', {
        skillId: MINGCE, skillName: '明策', playerId: ownerId, targetId: userId,
        logText: `${owner.nickname}发动【明策】，将一张牌交给${user.nickname}`,
      }, { sourceId: ownerId, targetId: userId })

      /*
       * 牌到手之后才算攻击范围。拿不出合法的 B 时**直接摸一张**，
       * 不弹一个只能拒绝的空窗口。
       */
      const slashTargets = slashTargetsFor(host.state, userId!)
      if (slashTargets.length === 0) {
        drawCards(host.state, host.rng, userId!, 1, (name, payload) => { host.dispatch(name, payload) })
        return
      }
      host.askSkill({
        skillId: MINGCE, ownerId, step: 'victim', data: { userId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【明策】：指定一名${user.nickname}攻击范围内的角色`,
          timeoutMs: 20_000, optional: false,
          // B 可以是陈宫本人，只要在 A 的攻击范围里
          candidateIds: slashTargets, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'victim') {
      const userId = resolution.data.userId as PlayerId
      const [victimId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const user = playerOf(host.state, userId)
      const victim = victimId ? playerOf(host.state, victimId) : undefined
      if (!user?.alive || !victim?.alive) return
      host.askSkill({
        skillId: MINGCE, ownerId, step: 'choice', data: { userId, victimId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option',
          // 选哪一项是**收牌那个人**的决定
          playerId: userId,
          prompt: `【明策】：视为对${victim.nickname}使用一张【杀】，或摸一张牌`,
          timeoutMs: 25_000, optional: false,
          options: [
            { id: 'slash', label: `视为对${victim.nickname}使用【杀】` },
            { id: 'draw', label: '摸一张牌' },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'choice') {
      const userId = resolution.data.userId as PlayerId
      const victimId = resolution.data.victimId as PlayerId
      const user = playerOf(host.state, userId)
      if (!user?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'slash') {
        drawCards(host.state, host.rng, userId, 1, (name, payload) => { host.dispatch(name, payload) })
        return
      }
      const victim = playerOf(host.state, victimId)
      if (!victim?.alive) {
        // 发问期间目标没了：退回摸一张，不让这次明策白白落空
        drawCards(host.state, host.rng, userId, 1, (name, payload) => { host.dispatch(name, payload) })
        return
      }
      /*
       * **纯虚拟【杀】：没有实体子牌。**
       *
       * 刚从陈宫那里收到的那张【杀】仍然留在 A 手里——它是明策的代价，
       * 不是这一刀的载体。使用者和伤害来源都是 A，完整走公共虚拟杀，
       * 因此求闪、无双、享乐、藤甲、铁骑、马术全都照常。
       */
      host.beginVirtualSlash({ sourceId: userId, targetId: victimId, sourceSkillId: MINGCE })
    }
  },
})

// ─────────────────────────────── 智迟 ───────────────────────────────

/** 智迟现在是不是生效着。 */
function zhichiActive(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return false
  return owner.marks[ZHICHI_TURN] === state.turnNumber
}

registerSkillRuntime({
  id: ZHICHI,
  triggers: [{
    /*
     * 「你于回合外**受到伤害后**」。
     *
     * 挂在 `AfterDamage` 上：被完全防止的伤害根本走不到这个时机，
     * 被【绝情】换成失去体力的也一样——那两种情况下他没有受到伤害。
     * 一次 3 点伤害只派发一次 `AfterDamage`，所以自然「一次伤害算一次」。
     */
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      /*
       * **回合外**：当前回合角色是他自己就不触发。
       * 额外回合也是他自己的回合，同样不触发——判据是「谁的回合」，
       * 不是「第几个回合」。
       */
      if (host.state.currentPlayerId === ownerId) return
      if (owner.marks[ZHICHI_TURN] === host.state.turnNumber) return
      owner.marks[ZHICHI_TURN] = host.state.turnNumber
      host.dispatch('SkillActivated', {
        skillId: ZHICHI, skillName: '智迟', playerId: ownerId,
        logText: `${owner.nickname}发动【智迟】，直到本回合结束，【杀】与非延时锦囊牌对其无效`,
      }, { targetId: ownerId })
    },
  }],

  cardEffectInvalid(state, ownerId, _sourceId, cardName) {
    if (!zhichiActive(state, ownerId)) return false
    if (cardName === '杀') return true
    /*
     * **非延时锦囊**：延时锦囊（乐不思蜀、兵粮寸断、闪电）不受影响。
     * 判断走公共的牌名分类，不在这里另抄一份清单。
     */
    return cardCategoryOfName(cardName) === 'trick' && !DELAYED_TRICK_NAMES.has(cardName)
  },
})

/** 延时锦囊：智迟管不到它们。 */
const DELAYED_TRICK_NAMES = new Set(['乐不思蜀', '兵粮寸断', '闪电'])

export const CHENGONG: CharacterDefinition = {
  id: 'chengong',
  name: '陈宫',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2011',
  skills: [
    {
      id: MINGCE,
      name: '明策',
      description: '出牌阶段限一次，你可以将一张【杀】或装备牌交给一名其他角色，'
        + '然后其选择一项：视为对你选择的、其攻击范围内的另一名角色使用一张【杀】；或摸一张牌。',
    },
    {
      id: ZHICHI,
      name: '智迟',
      description: '锁定技，你于回合外受到伤害后，直到当前回合结束，【杀】和非延时锦囊牌对你无效。',
    },
  ],
}
