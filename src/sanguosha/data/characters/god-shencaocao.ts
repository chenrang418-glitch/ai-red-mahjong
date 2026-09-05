import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { flipCharacter } from '../../engine/character-state'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神曹操。本项目自研表述。
 *
 * 【归心】：每当你受到 1 点伤害后，若至少一名其他角色的区域内有牌，
 * 你可以从每名有牌的其他角色的区域内各获得一张牌，然后将你的武将牌翻面。
 * 【飞影】：锁定技，其他角色计算与你的距离时始终 +1。
 *
 * **采用原版逐名选择，不采用 2016 年底 OL 把归心改成随机获得牌的版本。**
 *
 * 三个容易写错的点：
 *
 * 1. **每 1 点伤害一次独立机会**。受到 2 点伤害就是两次，各自可以发动或放弃，
 *    各自翻一次面——初始正面的话，两次归心之后又回到正面。这是经典神曹操的
 *    重要机制，写成「一次伤害只发动一次」就丢了。
 * 2. **每名有牌的其他角色各拿一张**，不是全场只拿一张。八人局最多一次拿七张。
 * 3. **区域包含判定区**，不只是手牌和装备区。
 */

const GUIXIN = 'guixin'
const FEIYING = 'feiying'

/** 归心的候选区域：手牌、装备区、判定区。判定区要显式开，默认不含。 */
const GUIXIN_ZONES = { includeJudgingArea: true } as const

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/**
 * 归心要处理的其他角色，按**从神曹操座位起顺时针**的稳定顺序。
 *
 * 顺序必须确定：联机两端、重连前后、压测复现都要得到同一个结果。
 */
function guixinTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const total = state.players.length
  return state.players
    .filter((player) => player.alive && player.id !== ownerId && hasPickableCards(state, player.id, GUIXIN_ZONES))
    .sort((left, right) => (
      ((left.seat - owner.seat + total) % total) - ((right.seat - owner.seat + total) % total)
    ))
    .map((player) => player.id)
}

/**
 * 处理归心的下一名角色。
 *
 * **每处理一名都重新确认**该角色还活着、区域里还有牌——不能在发动时把全场
 * cardId 快照下来无脑搬：中途可能有人死亡、有人的牌被别的结算带走。
 * 名单走完之后才翻面。
 */
function continueGuixin(
  host: Parameters<NonNullable<Parameters<typeof registerSkillRuntime>[0]['startQueued']>>[0],
  ownerId: PlayerId,
  remaining: PlayerId[],
): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return

  const pending = [...remaining]
  while (pending.length > 0) {
    const targetId = pending.shift()!
    const target = playerOf(host.state, targetId)
    // 重新验证：这一刻还活着、区域里还有牌，才发问
    if (!target?.alive || !hasPickableCards(host.state, targetId, GUIXIN_ZONES)) continue
    const pickable = pickableCardsOf(host.state, targetId, GUIXIN_ZONES)
    host.askSkill({
      skillId: GUIXIN, ownerId, step: 'take', data: { targetId, remaining: pending },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【归心】：获得${target.nickname}区域里的一张牌`,
        timeoutMs: 30_000, optional: false, purpose: 'skill',
        // 装备区和判定区是公开的，给真实 cardId；手牌只给占位槽，不泄露牌面
        cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots,
        min: 1, max: 1,
      }),
    })
    return
  }

  // 所有角色都处理完了才翻面，翻面走公共入口
  flipCharacter(host as never, ownerId, GUIXIN)
  host.dispatch('SkillActivated', {
    skillId: GUIXIN, skillName: '归心', playerId: ownerId,
    logText: `${owner.nickname}发动【归心】，将武将牌翻面`,
  }, { sourceId: ownerId })
}

registerSkillRuntime({
  id: GUIXIN,
  announcesSelf: true,

  triggers: [{
    /**
     * 每受到 1 点伤害排一次机会。
     *
     * 和左慈【新生】同一条约定：按伤害点数逐次 `queueSkill`，
     * 引擎在场面干净时逐个回调 `startQueued`。就地发问会撞上
     * 仍在进行中的伤害链和濒死流程。
     */
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const amount = Math.max(0, Math.trunc(Number((context.event.payload as { amount?: unknown }).amount ?? 0)))
      // 来源为空（闪电、崩坏）时同样可以发动：归心不看伤害来源
      for (let point = 0; point < amount; point += 1) {
        host.queueSkill({ skillId: GUIXIN, ownerId, step: 'ask', data: {} })
      }
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'continue') {
      continueGuixin(host, ownerId, (prompt.data.remaining as PlayerId[]) ?? [])
      return
    }
    if (prompt.step !== 'ask') return
    if (!playerOf(host.state, ownerId)?.alive) return
    // 没有任何其他角色有牌时不发无意义的请求
    if (guixinTargets(host.state, ownerId).length === 0) return
    host.askSkill({
      skillId: GUIXIN, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '发动【归心】？从每名有牌的其他角色区域内各获得一张牌，然后将你的武将牌翻面',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动归心' }, { id: 'no', label: '放弃' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      // 放弃不翻面，也不消耗别的东西
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      continueGuixin(host, ownerId, guixinTargets(host.state, ownerId))
      return
    }

    if (resolution.step === 'take') {
      const targetId = resolution.data.targetId as PlayerId
      const remaining = (resolution.data.remaining as PlayerId[]) ?? []
      const picked = ((response.payload as { cardIds?: string[] }).cardIds ?? [])[0]
      if (picked) {
        // 占位槽要按**当前**手牌顺序还原，不能用发问时的快照
        const cardId = resolvePickedCard(host.state, targetId, picked)
        if (cardId) {
          // 真实移动。装备离场走 handleEquipmentLost（枭姬、白银狮子才不会被跳过）
          movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })
          host.dispatch('GainCard', {
            playerId: ownerId, cardIds: [cardId], reason: GUIXIN,
          }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        }
      }
      /*
       * **直接续下一名，不能走 `queueSkill`。**
       *
       * 技能队列是 FIFO：受到 2 点伤害时队列里排着两次归心机会，
       * 把「继续处理下一名角色」也塞进队列的话，第二次归心的问句会插在
       * 第一次归心的逐名流程中间——玩家拿到一半被问「要不要再发动一次归心」，
       * 而且第一次的翻面收尾被推到了第二次之后。
       * 一次归心内部的逐名流程必须自己走完。
       */
      continueGuixin(host, ownerId, remaining)
    }
  },
})

registerSkillRuntime({
  id: FEIYING,
  /**
   * 锁定技，其他角色计算与你的距离 +1。
   *
   * 方向是**别人到神曹操**，所以用 `fromOthers` 而不是 `toOthers`：
   * 神曹操算别人的距离不受影响。
   *
   * 走公共距离修正，和坐骑、马术、屯田在 `getDistance` 的同一条加法里，
   * 自然叠加，不会互相覆盖，也不用改座次距离。
   */
  distanceModifier: { fromOthers: 1 },
})

export const SHENCAOCAO: CharacterDefinition = {
  id: 'shencaocao',
  name: '神·曹操',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 3,
  pack: 'god',
  skills: [
    {
      id: GUIXIN,
      name: '归心',
      description: '每当你受到1点伤害后，若至少一名其他角色的区域内有牌，你可以从每名有牌的其他角色区域内各获得一张牌，然后将你的武将牌翻面。',
    },
    {
      id: FEIYING,
      name: '飞影',
      description: '锁定技，其他角色计算与你的距离时始终+1。',
    },
  ],
}
