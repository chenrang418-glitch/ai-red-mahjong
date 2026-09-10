import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { effectiveCardColor, registerSkillRuntime } from '../../engine/skills/runtime'
import { effectiveCardName } from '../../engine/zones'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 华雄（一将成名 2012）。
 *
 * 【耀武】：锁定技，当你受到红色【杀】造成的伤害后，
 *          伤害来源选择一项：回复 1 点体力，或摸一张牌。
 *
 * 六处最容易做错的：
 *
 * 1. **认的是「红色的【杀】」**：有效**牌名**属于【杀】，而且这张牌的
 *    有效**颜色**为红。红色火【杀】、红色雷【杀】照样触发——它们仍然是【杀】；
 *    黑色的一律不触发。
 * 2. **必须是真的受到了伤害**：挂在 `AfterDamage` 上，被防止的、
 *    被【绝情】换成失去体力的都走不到这里。
 * 3. **非【杀】伤害不触发**：决斗、火攻、闪电、崩坏都不算。
 * 4. **选择权在伤害来源**，不是华雄、也不是当前回合角色。
 *    请求必须发给那名玩家。
 * 5. **来源为空、已阵亡、或就是华雄自己时直接跳过**，不弹一个无效选择。
 * 6. **来源满血时「回复 1 点」这一项仍然给**：它是一个合法选择，
 *    只是没有收益。不替玩家把它藏起来。
 */

export const YAOWU = 'yaowu'
const RECOVER = 'yaowu-recover'
const DRAW = 'yaowu-draw'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/**
 * 这次伤害是不是一张**红色的【杀】**造成的。
 *
 * 两条都读**有效**值，不读牌面：
 *
 * - 牌名走 `effectiveCardName`，所以转化出来的【杀】（武圣的红牌、父魂的
 *   两张手牌）同样算【杀】；
 * - 颜色走 `effectiveCardColor`，所以颜色改写算数——父魂那张混色合成的
 *   【杀】是**无色**的，不触发。
 *
 * 属性不看：火【杀】、雷【杀】仍然是【杀】，只要它是红的就算。
 */
export function isRedSlashDamage(state: SanguoshaState, cardId: CardId | null | undefined): boolean {
  if (!cardId) return false
  if (!state.cards[cardId]) return false
  if (effectiveCardName(state, cardId) !== '杀') return false
  // 有效颜色以**受伤者**的视角读；颜色改写不是按视角的，这里只是统一入口
  return effectiveCardColor(state, state.currentPlayerId, cardId) === 'red'
}

registerSkillRuntime({
  id: YAOWU,

  triggers: [{
    /*
     * 「受到红色【杀】造成的伤害后」。
     *
     * 挂在 `AfterDamage` 上，而且**排队**再发问：伤害还在结算链里，
     * 当场发问会把一个请求塞进属性传导中间。排队等牌局干净了再问，
     * 和荀攸【智愚】同一条约定。
     */
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const payload = context.event.payload as { cardId?: CardId | null }
      if (!isRedSlashDamage(host.state, payload.cardId)) return
      const sourceId = (context.event.sourceId as PlayerId | undefined) ?? null
      /*
       * **来源必须是别人、而且还活着。**
       *
       * 无来源的伤害（闪电、崩坏）根本不会带 `sourceId`；
       * 自己打自己（反伤、连环传导回自己）也不该让自己挑收益。
       * 这里先筛一遍，排队之后落地时再筛一遍——排队期间他可能已经死了。
       */
      if (!sourceId || sourceId === ownerId) return
      if (!playerOf(host.state, sourceId)?.alive) return
      host.queueSkill({ skillId: YAOWU, ownerId, step: 'choose', data: { sourceId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    const sourceId = prompt.data.sourceId as PlayerId | undefined
    const source = sourceId ? playerOf(host.state, sourceId) : undefined
    // 排队期间来源可能已经阵亡：那就安静地跳过，不弹一个无人可答的请求
    if (!sourceId || !source?.alive) return
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    host.askSkill({
      skillId: YAOWU, ownerId, step: 'choose', data: { sourceId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId,
        kind: 'choose-option',
        // **请求发给伤害来源**，不是华雄
        playerId: sourceId,
        prompt: `${owner.nickname}的锁定技【耀武】：选择一项`,
        timeoutMs: 20_000,
        // 锁定技：来源必须选一项，不能不选
        optional: false,
        options: [
          /*
           * 满血时「回复 1 点」照样给。
           *
           * 它是一个合法选择，只是没有收益——替玩家把它藏起来等于
           * 替他做决定，而且会让「两个选项」在某些局面下变成一个。
           */
          { id: RECOVER, label: '回复 1 点体力' },
          { id: DRAW, label: '摸一张牌' },
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const sourceId = resolution.data.sourceId as PlayerId | undefined
    const source = sourceId ? playerOf(host.state, sourceId) : undefined
    if (!sourceId || !source?.alive) return
    const owner = playerOf(host.state, ownerId)
    const choice = (response.payload as { optionId?: string }).optionId

    if (choice === RECOVER) {
      host.dispatch('SkillActivated', {
        skillId: YAOWU, skillName: '耀武', playerId: ownerId, targetId: sourceId,
        logText: `${owner?.nickname ?? '华雄'}的【耀武】令${source.nickname}回复 1 点体力`,
      }, { sourceId: ownerId, targetId: sourceId })
      // 满血时 recover 自然回不了：这是「没有收益」，不是「非法选择」
      recover(host as never, sourceId, 1, ownerId)
      return
    }

    host.dispatch('SkillActivated', {
      skillId: YAOWU, skillName: '耀武', playerId: ownerId, targetId: sourceId,
      logText: `${owner?.nickname ?? '华雄'}的【耀武】令${source.nickname}摸一张牌`,
    }, { sourceId: ownerId, targetId: sourceId })
    drawCards(host.state, host.rng, sourceId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const HUAXIONG: CharacterDefinition = {
  id: 'huaxiong',
  name: '华雄',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 6,
  pack: 'yjcm2012',
  skills: [
    {
      id: YAOWU,
      name: '耀武',
      description: '锁定技，当你受到红色【杀】造成的伤害后，伤害来源选择一项：回复1点体力，或摸一张牌。',
    },
  ],
}
