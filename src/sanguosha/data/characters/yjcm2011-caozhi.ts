import { flipCharacter } from '../../engine/character-state'
import { newDiscardEntries } from '../../engine/discard-provenance'
import { recover } from '../../engine/recover'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { applyWineEffect, canUseWineThisTurn, useVirtualWine } from '../../engine/virtual-wine'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹植（一将成名 2011）。
 *
 * 【落英】：其他角色的一张梅花牌因弃置或判定而进入弃牌堆时，你可以获得之。
 * 【酒诗】：你需要使用【酒】时，若你的武将牌正面朝上，你可以将武将牌翻面，
 *   视为使用了一张【酒】；你受到的伤害结算结束后，若你的武将牌背面朝上，
 *   你可以将武将牌翻回正面。
 *
 * 四处最容易做错的：
 *
 * 1. **落英看的是「怎么进的弃牌堆」，不是「弃牌堆里有什么」。** 用过的【杀】
 *    结算完同样躺在弃牌堆里，但那不算——扫弃牌堆找梅花是错的。
 * 2. **结算的那一刻要重新验一遍牌还在不在。** 中间可能已经被别的效果拿走了，
 *    再「获得」一次就是凭空复制一张牌。
 * 3. **酒诗的代价是翻面，不是弃牌**，而且要和真酒共用同一套酒的账。
 * 4. **翻回正面是「受到伤害结算结束后」**：一次 3 点伤害只给一次机会，
 *    伤害被完全防止则根本没有这一次。
 */

const LUOYING = 'luoying'
const JIUSHI = 'jiushi'

/** 落英已经看到哪个事件序号为止，避免同一张牌被反复提供。 */
const LUOYING_CURSOR = 'luoying-cursor'
/** 酒诗在濒死求救时的动作 id。 */
const JIUSHI_RESCUE_ACTION = 'rescue-jiushi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 落英 ───────────────────────────────

/**
 * 现在可以被落英拿走的牌。
 *
 * 四个条件缺一不可：**梅花**、**在弃牌堆里**、**因弃置或判定进去的**、
 * **不是曹植自己的牌**。最后一条包括他自己的判定牌——那也是他自己的牌。
 */
function luoyingCandidates(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const cursor = playerOf(state, ownerId)?.marks[LUOYING_CURSOR] ?? 0
  return newDiscardEntries(state, cursor, (entry, cardId) => {
    if (entry.reason !== 'discard' && entry.reason !== 'judgment') return false
    // 自己的牌不算。牌堆顶翻出来的判定牌没有归属（ownerId 为 null），算「其他角色的」
    if (entry.ownerId === ownerId) return false
    return state.cards[cardId]?.suit === 'club'
  })
}

/** 把光标推到当前序号：这一批已经问过了，不再重复提供。 */
function advanceCursor(state: SanguoshaState, ownerId: PlayerId): void {
  const owner = playerOf(state, ownerId)
  if (owner) owner.marks[LUOYING_CURSOR] = state.seq
}

registerSkillRuntime({
  id: LUOYING,
  triggers: [
    {
      /*
       * 弃牌和判定都会先走到这两个时机，然后牌才真正落进弃牌堆。
       *
       * 所以这里**只排队**，不当场判断：排队的东西要等牌桌干净了才放出来，
       * 那时候牌已经在弃牌堆里，`luoyingCandidates` 查得到，
       * 「有没有被别人先拿走」也才问得准。
       */
      event: 'LoseCard',
      handle(host, ownerId) {
        host.queueSkill({ skillId: LUOYING, ownerId, step: 'collect', data: {} })
      },
    },
    {
      event: 'JudgeEnd',
      handle(host, ownerId) {
        host.queueSkill({ skillId: LUOYING, ownerId, step: 'collect', data: {} })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'collect') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = luoyingCandidates(host.state, ownerId)
    if (candidates.length === 0) {
      advanceCursor(host.state, ownerId)
      return
    }
    /*
     * 一次进弃牌堆好几张梅花时，**一次问完**。
     *
     * 服务端语义上每一张都是独立可获得的，所以这里 min 0 / max 全部——
     * 玩家想拿几张拿几张。拆成一张一问在规则上等价，但联机时每张都要一个往返。
     */
    host.askSkill({
      skillId: LUOYING, ownerId, step: 'collect', data: { candidates },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【落英】：获得其中的梅花牌',
        timeoutMs: 25_000, optional: true, purpose: 'skill',
        cardIds: candidates, hiddenCardSlots: [],
        min: 0, max: candidates.length,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'collect') return
    const picked = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    advanceCursor(host.state, ownerId)
    if (!owner?.alive || picked.length === 0) return
    /*
     * **落地前重新验一遍**：发问期间别的效果（固政、游医这类抢弃牌堆的技能）
     * 可能已经把牌拿走了。同一张牌只能被一个效果拿走，不能复制。
     */
    const legal = picked.filter((cardId) => luoyingCandidates(host.state, ownerId).includes(cardId)
      || host.state.zones.discardPile.includes(cardId))
    const gained = legal.filter((cardId) => host.state.zones.discardPile.includes(cardId))
    if (gained.length === 0) return
    for (const cardId of gained) {
      /*
       * 是**获得**，不是摸牌：从弃牌堆直接进手牌，
       * 不触发「摸牌时」那批时机，也不动牌堆。
       */
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    }
    host.dispatch('SkillActivated', {
      skillId: LUOYING, skillName: '落英', playerId: ownerId, cardIds: gained,
      logText: `${owner.nickname}发动【落英】，获得 ${gained.length} 张梅花牌`,
    }, { sourceId: ownerId, cardIds: gained })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: LUOYING }, { targetId: ownerId, cardIds: gained })
  },
})

// ─────────────────────────────── 酒诗 ───────────────────────────────

/** 现在能不能靠酒诗视为使用一张【酒】。 */
function canJiushi(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  // 已经背面朝上就付不起代价了——翻面是它的成本
  return !!owner?.alive && !owner.faceDown
}

registerSkillRuntime({
  id: JIUSHI,
  activeActions(state, ownerId) {
    if (!canJiushi(state, ownerId)) return []
    // 和实体酒共用「本回合限一次」的账
    if (state.turnUsage.wineUses >= 1) return []
    return [{ id: JIUSHI, label: '发动【酒诗】：翻面视为使用一张【酒】' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== JIUSHI) return
    if (!canJiushi(host.state, ownerId) || !canUseWineThisTurn(host)) return
    const owner = playerOf(host.state, ownerId)!
    flipCharacter(host as never, ownerId, JIUSHI, true)
    host.dispatch('SkillActivated', {
      skillId: JIUSHI, skillName: '酒诗', playerId: ownerId,
      logText: `${owner.nickname}发动【酒诗】，将武将牌翻面，视为使用一张【酒】`,
    }, { sourceId: ownerId })
    useVirtualWine(host, ownerId, JIUSHI)
    applyWineEffect(host)
  },
  /** 濒死时同样可以靠酒诗视为使用一张【酒】自救。 */
  rescueActions(state, ownerId, dyingPlayerId) {
    // 酒只能救自己：和实体酒同一条规则
    if (ownerId !== dyingPlayerId || !canJiushi(state, ownerId)) return []
    return [{ id: JIUSHI_RESCUE_ACTION, label: '发动【酒诗】：翻面视为使用一张【酒】' }]
  },
  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    if (actionId !== JIUSHI_RESCUE_ACTION) return false
    if (ownerId !== dyingPlayerId || !canJiushi(host.state, ownerId)) return false
    const owner = playerOf(host.state, ownerId)!
    flipCharacter(host, ownerId, JIUSHI, true)
    host.dispatch('SkillActivated', {
      skillId: JIUSHI, skillName: '酒诗', playerId: ownerId,
      logText: `${owner.nickname}发动【酒诗】，翻面视为使用一张【酒】自救`,
    }, { sourceId: ownerId })
    useVirtualWine(host, ownerId, JIUSHI)
    /*
     * 濒死时的酒和桃一样回复 1 点体力——这条是本项目既有的濒死规则，
     * 实体酒走的也是同一段。这里不另起一套。
     */
    recover(host as never, ownerId, 1, ownerId)
    return true
  },
  triggers: [{
    /*
     * 「你受到的伤害**结算结束后**」。
     *
     * 挂在 `AfterDamage` 上而不是 `BeforeDamage`：被完全防止的伤害根本走不到
     * 这个时机，那种情况下没有「受到过伤害」可言，也就没有这一次翻回机会。
     * 一次 3 点伤害只派发一次 `AfterDamage`，所以自然只给一次机会。
     */
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      // 现在正面朝上就没什么可翻的——中途被别的效果翻正了也算数
      if (!owner?.alive || !owner.faceDown) return
      host.queueSkill({ skillId: JIUSHI, ownerId, step: 'restore', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'restore') return
    const owner = playerOf(host.state, ownerId)
    // 排队期间可能已经被翻正了，落地前再看一眼当前状态
    if (!owner?.alive || !owner.faceDown) return
    host.askSkill({
      skillId: JIUSHI, ownerId, step: 'restore',
      build: (requestId) => ({
        id: requestId, kind: 'choose-option' as const, playerId: ownerId,
        prompt: '【酒诗】：将武将牌翻回正面？',
        timeoutMs: 20_000, optional: true,
        options: [
          { id: 'flip', label: '翻回正面' },
          // 可选的单选请求必须给一条真的「不发动」，否则玩家点不了放弃
          { id: 'cancel', label: '保持背面' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'restore') return
    if ((response.payload as { optionId?: string }).optionId !== 'flip') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !owner.faceDown) return
    flipCharacter(host, ownerId, JIUSHI, false)
    host.dispatch('SkillActivated', {
      skillId: JIUSHI, skillName: '酒诗', playerId: ownerId,
      logText: `${owner.nickname}将武将牌翻回正面`,
    }, { sourceId: ownerId })
  },
})

export const CAOZHI: CharacterDefinition = {
  id: 'caozhi',
  name: '曹植',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2011',
  skills: [
    {
      id: LUOYING,
      name: '落英',
      description: '当其他角色的一张梅花牌因弃置或判定而进入弃牌堆时，你可以获得之。',
    },
    {
      id: JIUSHI,
      name: '酒诗',
      description: '当你需要使用【酒】时，若你的武将牌正面朝上，你可以将武将牌翻面，视为使用了一张【酒】；你受到的伤害结算结束后，若你的武将牌背面朝上，你可以将武将牌翻回正面。',
    },
  ],
}
