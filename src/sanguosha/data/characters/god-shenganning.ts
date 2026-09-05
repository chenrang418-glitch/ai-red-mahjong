import { drawCards } from '../../engine/draw'
import { carriesToken, createToken, moveToken, removeToken, tokenCarriedBy, tokenExists, tokenOwnedBy } from '../../engine/global-token'
import { loseMaxHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { CardId, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 神甘宁。本项目的自研玩法表述。
 * 体力上限 6 / **初始体力 3**。
 *
 * 【魄袭】：出牌阶段限一次，你可以观看一名其他角色的手牌，
 *   然后你可以弃置你与其手里的四张牌（必须为四张且花色各不相同）。
 *   若如此做，根据此次弃置你的牌数量执行以下效果：
 *   没有，体力上限减 1；一张，结束出牌阶段且本回合手牌上限 -1；
 *   三张，回复 1 点体力；四张，摸四张牌。
 * 【劫营】：回合开始时，若全场没有有「营」的角色，你获得一个「营」标记；
 *   结束阶段，你可以将「营」放到一名其他角色武将旁；
 *   有「营」的角色摸牌阶段多摸一张牌、出牌阶段可多使用一张【杀】、手牌上限 +1；
 *   有「营」的其他角色回合结束后，移去「营」，然后你获得其所有手牌。
 *
 * 四个最容易漏的地方：
 *
 * 1. **弃两张时什么都不发生**——文本只列了 0/1/3/4，2 张没有任何附加效果。
 * 2. **看牌即消耗次数**：正式选定目标看完手牌之后，本阶段不能再换一个目标看第二次，
 *    哪怕凑不出四花色、或者选择不弃。
 * 3. 0 张走公共 `loseMaxHp`，上限可以一路降到 0 并按通用规则死亡，不 clamp 到 1。
 * 4. 其他角色的回合结束后是**移去「营」**，不是立刻回到神甘宁身上；
 *    他要等自己下一个回合开始、发现全场没有营，才会重新获得。
 */

const POXI = 'poxi'
const JIEYING = 'jieying-ganning'

/** 「营」标记名。 */
export const CAMP_TOKEN = '营'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 魄袭 ───────────────────────────────

registerSkillRuntime({
  id: POXI,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisTurn(state, ownerId, POXI)) return []
    // 目标必须有手牌可看，否则这个动作没有意义
    const hasTarget = state.players.some((player) => (
      player.alive && player.id !== ownerId && player.zones.hand.length > 0
    ))
    if (!hasTarget) return []
    return [{ id: POXI, label: '魄袭（观看一名其他角色的手牌）' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== POXI) return
    if (usedThisTurn(host.state, ownerId, POXI)) return
    const candidateIds = host.state.players
      .filter((player) => player.alive && player.id !== ownerId && player.zones.hand.length > 0)
      .map((player) => player.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: POXI, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【魄袭】：选择一名其他角色，观看其手牌',
        timeoutMs: 30_000,
        // 可取消，取消不消耗本阶段次数
        optional: true, candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      /*
       * **看牌即消耗次数。** 正式选定目标之后本阶段就不能再换人看第二次，
       * 哪怕凑不出四花色、或者最后选择不弃。
       */
      markUsedThisTurn(host.state, ownerId, POXI)

      const owner = playerOf(host.state, ownerId)!
      const target = playerOf(host.state, targetId)!
      /*
       * 候选池是**双方手牌合起来**。这条请求只发给神甘宁本人，
       * 所以目标的手牌牌面只有他看得到——和神吕蒙【攻心】同一条隐私通道
       * （`buildPlayerView` 只下发属于查看者自己的 Request）。
       */
      const pool = [...owner.zones.hand, ...target.zones.hand]
      host.askSkill({
        skillId: POXI, ownerId, step: 'discard', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【魄袭】：观看${target.nickname}的手牌，可以弃置你与其手里的四张牌`
            + '（必须为四张且花色各不相同）',
          timeoutMs: 30_000,
          // 可以选择不弃，所以 min 是 0；真要弃就必须正好四张
          optional: true, purpose: 'skill',
          cardIds: pool, hiddenCardSlots: [],
          min: 0, max: 4,
        }),
      })
      return
    }

    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const cardIds = ((response.payload as { cardIds?: CardId[] }).cardIds ?? [])
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive) return
      // 选择不弃：看完就结束，没有后续效果
      if (cardIds.length === 0) return

      /*
       * 落地前**重新验一次**：恰好四张、id 唯一、四种不同花色、
       * 而且每一张都还在对应的手牌区里。
       */
      const unique = [...new Set(cardIds)]
      if (unique.length !== 4) return
      const suits = new Set<Suit>()
      const fromOwner: CardId[] = []
      const fromTarget: CardId[] = []
      for (const cardId of unique) {
        const suit = host.state.cards[cardId]?.suit
        if (!suit) return
        suits.add(suit)
        if (owner.zones.hand.includes(cardId)) fromOwner.push(cardId)
        else if (target?.zones.hand.includes(cardId)) fromTarget.push(cardId)
        else return
      }
      // **四种不同花色**，不是四种颜色
      if (suits.size !== 4) return

      // 一次性原子弃置，不逐张发问
      for (const cardId of fromOwner) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      }
      for (const cardId of fromTarget) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      }
      if (fromOwner.length > 0) {
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: fromOwner, reason: POXI }, { sourceId: ownerId, cardIds: fromOwner })
      }
      if (fromTarget.length > 0) {
        host.dispatch('LoseCard', { playerId: targetId, cardIds: fromTarget, reason: POXI }, { targetId, cardIds: fromTarget })
      }

      const own = fromOwner.length
      host.dispatch('SkillActivated', {
        skillId: POXI, skillName: '魄袭', playerId: ownerId, targetIds: [targetId],
        logText: `${owner.nickname}发动【魄袭】，弃置四张不同花色的牌（其中自己的 ${own} 张）`,
      }, { sourceId: ownerId, targetId })

      /*
       * 按**自己被弃掉的牌数**执行效果。
       * **两张什么都不发生**——文本只列了 0 / 1 / 3 / 4，这一条最容易被顺手补上。
       */
      if (own === 0) {
        // 上限可以一路降到 0 并按通用规则死亡，公共 loseMaxHp 已经这么做了
        loseMaxHp(host as never, ownerId, 1, POXI)
      } else if (own === 1) {
        // 本回合手牌上限 -1；弃牌阶段照常按 -1 结算
        owner.marks[POXI_MAXCARDS_MARK] = (owner.marks[POXI_MAXCARDS_MARK] ?? 0) + 1
        // **真正结束出牌阶段**，不是「不许再出牌但留在阶段里」
        host.endPlayPhaseEarly(ownerId)
      } else if (own === 3) {
        recover(host as never, ownerId, 1, POXI)
      } else if (own === 4) {
        drawCards(host.state, host.rng, ownerId, 4, (name, data) => { host.dispatch(name, data) })
      }
    }
  },

  /** 魄袭「弃一张」的本回合手牌上限 -1。回合结束由 turn.ts 统一清标记。 */
  maxCardsBonus(state, ownerId) {
    return -(playerOf(state, ownerId)?.marks[POXI_MAXCARDS_MARK] ?? 0)
  },
})

/** 魄袭「弃一张」留下的本回合手牌上限 -1 标记。 */
export const POXI_MAXCARDS_MARK = 'poxi-maxcards'

// ─────────────────────────────── 劫营 ───────────────────────────────

registerSkillRuntime({
  id: JIEYING,

  triggers: [
    {
      /** 回合开始时，若全场没有「营」，获得一个。 */
      event: 'TurnStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        if (!playerOf(host.state, ownerId)?.alive) return
        if (tokenExists(host.state, CAMP_TOKEN)) return
        createToken(host.state, CAMP_TOKEN, ownerId)
        host.dispatch('SkillActivated', {
          skillId: JIEYING, skillName: '劫营', playerId: ownerId,
          logText: `${playerOf(host.state, ownerId)?.nickname}获得「营」`,
        }, { sourceId: ownerId })
      },
    },
    {
      /** 结束阶段，可以把「营」放到一名**其他**角色武将旁。 */
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        if (!playerOf(host.state, ownerId)?.alive) return
        if (host.state.skillResolution) return
        // 只有营在自己身上时才谈得上转移
        if (!carriesToken(host.state, ownerId, CAMP_TOKEN)) return
        const candidateIds = host.state.players
          .filter((player) => player.alive && player.id !== ownerId)
          .map((player) => player.id)
        if (candidateIds.length === 0) return
        host.askSkill({
          skillId: JIEYING, ownerId, step: 'give',
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【劫营】：可以将「营」放到一名其他角色武将旁（不发动就留在自己身上）',
            timeoutMs: 30_000,
            // 本项目表述是「一名其他角色」，所以候选里没有自己；不发动＝继续留着
            optional: true, candidateIds, min: 0, max: 1,
          }),
        })
      },
    },
    {
      /**
       * 有「营」的**其他角色**回合结束后：移去「营」，然后神甘宁获得其所有手牌。
       *
       * 「回合结束后」认的是回合实例，所以额外回合、因翻面被跳过的回合
       * 同样会走到这里——那些也都是实际发生过的回合。
       */
      event: 'TurnEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        const carrierId = payload.playerId
        if (!carrierId || carrierId === ownerId) return
        const token = tokenCarriedBy(host.state, carrierId, CAMP_TOKEN)
        // 只回收属于自己的那一枚（娱乐局可能有两个神甘宁）
        if (!token || token.ownerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        const carrier = playerOf(host.state, carrierId)
        // 先移去营
        removeToken(host.state, CAMP_TOKEN, ownerId)
        if (!owner?.alive || !carrier?.alive) return
        // 然后获得其所有手牌。是**真实移动**，不是弃置，不触发「因弃置手牌」类技能
        const taken = [...carrier.zones.hand]
        for (const cardId of taken) {
          moveCard(host.state, cardId, { kind: 'hand', playerId: carrierId }, { kind: 'hand', playerId: ownerId })
        }
        host.dispatch('SkillActivated', {
          skillId: JIEYING, skillName: '劫营', playerId: ownerId, targetIds: [carrierId],
          logText: `${owner.nickname}移去${carrier.nickname}的「营」，获得其 ${taken.length} 张手牌`,
        }, { sourceId: ownerId, targetId: carrierId })
        if (taken.length > 0) {
          host.dispatch('GainCard', { playerId: ownerId, cardIds: taken, reason: JIEYING }, { sourceId: ownerId, targetId: carrierId, cardIds: taken })
        }
      },
    },
    {
      /** 有「营」的角色摸牌阶段多摸一张。阶段被跳过时事件不派发，自然不多摸。 */
      event: 'DrawPhase',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; count?: number }
        const drawerId = payload.playerId
        if (!drawerId) return
        const token = tokenCarriedBy(host.state, drawerId, CAMP_TOKEN)
        if (!token || token.ownerId !== ownerId) return
        payload.count = Math.max(0, Math.trunc(Number(payload.count ?? 2))) + 1
      },
    },
  ],

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'give') return
    const targetId = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])[0]
    // 不发动就是继续留在自己身上
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    if (!tokenOwnedBy(host.state, ownerId, CAMP_TOKEN)) return
    moveToken(host.state, CAMP_TOKEN, ownerId, targetId)
    host.dispatch('SkillActivated', {
      skillId: JIEYING, skillName: '劫营', playerId: ownerId, targetIds: [targetId],
      logText: `${playerOf(host.state, ownerId)?.nickname}将「营」放到${playerOf(host.state, targetId)?.nickname}武将旁`,
    }, { sourceId: ownerId, targetId })
  },

  /**
   * 有「营」的角色手牌上限 +1、出杀次数 +1。
   *
   * 两条都是**全场效果**（因为场上有神甘宁，营的持有者才受益），
   * 所以走 `globalMaxCardsBonus` / `globalSlashUses`，
   * 不是只影响拥有者自己的那两个钩子。
   */
  globalMaxCardsBonus(state, ownerId, targetId) {
    const token = tokenCarriedBy(state, targetId, CAMP_TOKEN)
    return token && token.ownerId === ownerId ? 1 : 0
  },

  globalSlashUses(state, ownerId, targetId) {
    const token = tokenCarriedBy(state, targetId, CAMP_TOKEN)
    return token && token.ownerId === ownerId ? 1 : 0
  },
})

export const SHENGANNING: CharacterDefinition = {
  id: 'shenganning',
  name: '神·甘宁',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 6,
  // **初始体力 3**，不等于体力上限
  initialHp: 3,
  pack: 'god',
  skills: [
    {
      id: POXI,
      name: '魄袭',
      description: '出牌阶段限一次，你可以观看一名其他角色的手牌，然后你可以弃置你与其手里的四张牌（必须为四张且花色各不相同）。若如此做，根据此次弃置你的牌数量执行以下效果：没有，体力上限减1；一张，结束出牌阶段且本回合手牌上限-1；三张，回复1点体力；四张，摸四张牌。',
    },
    {
      id: JIEYING,
      name: '劫营',
      description: '回合开始时，若全场没有有「营」的角色，你获得一个「营」标记；结束阶段，你可以将「营」放到一名其他角色武将旁；有「营」的角色摸牌阶段多摸一张牌、出牌阶段可多使用一张【杀】、手牌上限+1；有「营」的其他角色回合结束后，移去「营」，然后你获得其所有手牌。',
    },
  ],
}
