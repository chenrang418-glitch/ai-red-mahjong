import { reshuffleDrawPile } from '../../engine/deck'
import { discardAllCards } from '../../engine/discard-all'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { moveCard } from '../../engine/zones'
import type { ArrangeCardsRequest, ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 马谡（一将成名 2011 原版）。
 *
 * 【心战】：出牌阶段限一次，若你的手牌数大于你的体力上限，你可以观看牌堆顶的三张牌，
 *          展示其中任意数量的红桃牌并获得之，然后将其余的牌以任意顺序置于牌堆顶。
 * 【挥泪】：锁定技，当你死亡时，杀死你的角色弃置其所有的牌。
 *
 * 六处最容易做错的：
 *
 * 1. **条件比的是体力上限，不是当前体力。** 1/3 血、手牌 3 张发不了，
 *    手牌 4 张才行。上限被别的技能改动时条件实时变化，不能写死成「大于 3」。
 * 2. **牌不能先从牌堆里拿出来再慢慢问。** 三张牌全程留在牌堆里，
 *    只是被这个人「看到」；中途断线、超时、牌局结束，牌都还在原地。
 *    先删后问的写法一旦在中间崩掉，三张牌就凭空消失了。
 * 3. **只有红桃能选，而且可以一张都不选。** 一张都不取时三张全部进入重排——
 *    这本身就是心战的价值之一，不是「什么都没发生」。
 * 4. **未被展示的牌不能泄露。** 请求只下发给马谡本人；被选中的红桃先经过
 *    处理区公开展示，再进他的手牌。
 * 5. **重排是真的写回牌堆顶**，之后的摸牌、判定、观星读到的就是这个顺序。
 * 6. **挥泪只在真的死了、而且有击杀者时才生效**，不去凑一个「最后打我的人」。
 */

const XINZHAN = 'xinzhan'
const HUILEI = 'huilei'
const XINZHAN_ACTION = 'xinzhan-invoke'

/** 心战一次看几张。牌堆凑不出三张时看得到几张算几张。 */
const XINZHAN_PEEK = 3

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 现在能不能发动心战。**手牌数 > 体力上限**，不是「大于当前体力」。 */
function xinzhanReady(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return false
  return owner.zones.hand.length > owner.maxHp
}

function isHeart(state: SanguoshaState, cardId: CardId): boolean {
  return state.cards[cardId]?.suit === 'heart'
}

registerSkillRuntime({
  id: XINZHAN,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisTurn(state, ownerId, XINZHAN)) return []
    if (!xinzhanReady(state, ownerId)) return []
    if (state.zones.drawPile.length === 0 && state.zones.discardPile.length === 0) return []
    return [{ id: XINZHAN_ACTION, label: '心战：观看牌堆顶三张，获得其中的红桃并重排其余' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== XINZHAN_ACTION) return
    if (!xinzhanReady(host.state, ownerId)) return
    // 牌堆不足时走统一重洗；重洗之后仍然不足就看得到几张算几张
    if (host.state.zones.drawPile.length < XINZHAN_PEEK) {
      reshuffleDrawPile(host.state, host.rng, (name, payload) => { host.dispatch(name, payload) })
    }
    const top = host.state.zones.drawPile.slice(0, XINZHAN_PEEK)
    if (top.length === 0) return
    markUsedThisTurn(host.state, ownerId, XINZHAN)
    const owner = playerOf(host.state, ownerId)
    host.dispatch('SkillActivated', {
      skillId: XINZHAN, skillName: '心战', playerId: ownerId,
      logText: `${owner?.nickname ?? ''}发动【心战】，观看牌堆顶 ${top.length} 张牌`,
    }, { sourceId: ownerId })

    const hearts = top.filter((cardId) => isHeart(host.state, cardId))
    host.askSkill({
      skillId: XINZHAN, ownerId, step: 'pick', data: { top },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【心战】：展示并获得其中任意数量的红桃牌（可以一张都不取）`,
        timeoutMs: 30_000, optional: true, purpose: 'skill',
        // 三张都看得见，但只有红桃能选中
        cardIds: hearts,
        viewOnlyCardIds: top.filter((cardId) => !hearts.includes(cardId)),
        hiddenCardSlots: [],
        min: 0, max: hearts.length,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'pick') {
      const top = (resolution.data.top as CardId[]) ?? []
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? [])
        /*
         * 落地前重新验一遍：只认**当时看到的那三张里、确实是红桃、
         * 而且现在还在牌堆里**的牌。发问期间别的效果可能已经把牌拿走了，
         * 那时再「获得」一次就是凭空多出一张。
         */
        .filter((cardId) => top.includes(cardId)
          && isHeart(host.state, cardId)
          && host.state.zones.drawPile.includes(cardId))
      const taken = [...new Set(picked)]

      if (taken.length > 0 && owner?.alive) {
        /*
         * 先公开展示再进手牌：**展示**是这个技能明确要求的一步，
         * 全场都该看到他拿走了哪几张。经过处理区就是本项目「公开亮出」的做法。
         */
        for (const cardId of taken) {
          moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
        }
        host.dispatch('CardMove', { cardIds: taken, reason: XINZHAN, revealed: true }, { cardIds: taken })
        for (const cardId of taken) {
          moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
        }
        host.dispatch('GainCard', { playerId: ownerId, cardIds: taken, reason: XINZHAN }, { targetId: ownerId, cardIds: taken })
      }

      const remaining = top.filter((cardId) => !taken.includes(cardId) && host.state.zones.drawPile.includes(cardId))
      if (remaining.length === 0) return
      if (remaining.length === 1) {
        // 只剩一张时没有「顺序」可言，不弹一个只有一种答案的窗口
        return
      }
      host.askSkill({
        skillId: XINZHAN, ownerId, step: 'arrange', data: { remaining },
        build: (requestId): ArrangeCardsRequest => ({
          id: requestId, kind: 'arrange-cards', playerId: ownerId,
          prompt: '【心战】：将其余的牌以任意顺序置于牌堆顶',
          timeoutMs: 30_000, optional: false,
          cardIds: remaining,
          // 心战只能放回牌堆**顶**，没有「置于牌堆底」这个选项
          minTop: remaining.length, maxTop: remaining.length, allowBottom: false,
        }),
      })
      return
    }

    if (resolution.step === 'arrange') {
      const remaining = (resolution.data.remaining as CardId[]) ?? []
      const { top } = response.payload as { top?: CardId[] }
      /*
       * 只重排「这几张、而且现在还在牌堆里」的牌，其余的牌保持原有相对顺序。
       * 快照里的牌若在这期间离开了牌堆，就不能再写回去，否则会凭空多出一张。
       */
      const observed = new Set(remaining)
      const ordered = (top ?? [])
        .filter((cardId) => observed.has(cardId) && host.state.zones.drawPile.includes(cardId))
      const complete = [...ordered, ...remaining.filter((cardId) => !ordered.includes(cardId)
        && host.state.zones.drawPile.includes(cardId))]
      const untouched = host.state.zones.drawPile.filter((cardId) => !observed.has(cardId))
      host.state.zones.drawPile = [...complete, ...untouched]
    }
  },
})

// ─────────────────────────────── 挥泪 ───────────────────────────────

registerSkillRuntime({
  id: HUILEI,
  triggers: [{
    event: 'Death',
    /*
     * 挥泪是**自己死的时候**发动的，触发时拥有者已经不在场上了。
     * 不声明这一条的话，触发器会把死人跳过去，技能一次也不会响。
     */
    allowDeadOwner: true,
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      /*
       * **必须有击杀者。**
       *
       * 崩坏、闪电、无来源的伤害、技能直接判死都没有击杀者，
       * 这时挥泪不生效——不去找「最后一次打过我的人」来顶替。
       * 归属统一由死亡事件的来源给出，不自己另记一本账。
       */
      const killerId = context.event.sourceId as PlayerId | undefined
      if (!killerId || killerId === ownerId) return
      const killer = playerOf(host.state, killerId)
      if (!killer?.alive) return
      const owner = playerOf(host.state, ownerId)
      host.dispatch('SkillActivated', {
        skillId: HUILEI, skillName: '挥泪', playerId: ownerId, targetId: killerId,
        logText: `${owner?.nickname ?? ''}发动【挥泪】，${killer.nickname}弃置所有的牌`,
      }, { sourceId: ownerId, targetId: killerId })
      /*
       * 走公共的「弃置所有牌」：手牌 + 装备区，不含判定区。
       * 是真的逐张弃置，枭姬、旋风、落英、伤逝、白银狮子照常触发。
       */
      discardAllCards(host as never, killerId, HUILEI)
    },
  }],
})

export const MASU: CharacterDefinition = {
  id: 'masu',
  name: '马谡',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2011',
  skills: [
    {
      id: XINZHAN,
      name: '心战',
      description: '出牌阶段限一次，若你的手牌数大于你的体力上限，你可以观看牌堆顶的三张牌，'
        + '展示其中任意数量的红桃牌并获得之，然后将其余的牌以任意顺序置于牌堆顶。',
    },
    {
      id: HUILEI,
      name: '挥泪',
      description: '锁定技，当你死亡时，杀死你的角色弃置其所有的牌。',
    },
  ],
}
