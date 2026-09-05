import { revealTopCards } from '../../engine/draw'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import type { ChooseOptionRequest } from '../../engine/requests'
import { registerSkillRuntime, effectiveCardSuit, type SkillHost } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 林包·孟获。本项目自研表述。
 *
 * 两个技能都**只消费公共机制**，引擎主干里不出现 menghuo：
 *
 * - 【祸首】的「南蛮入侵对你无效」走 `cardEffectInvalid`，
 *   和藤甲一起汇进 `equipment.ts` 的 `isCardIneffective`；
 *   「伤害来源视为你」走 `modifyDamageSource`，在 `damage.ts` 的所有伤害时机之前生效。
 * - 【再起】的摸牌阶段替代走已有的「取消 DrawPhase 事件」约定（和裸衣、突袭、双雄同一条），
 *   亮牌走 `engine/draw.ts` 的公共 `revealTopCards`，回血走公共 `recover`。
 */

export const HUOSHOU = 'huoshou'
export const ZAIQI = 'zaiqi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

/** 已损失体力值。**不写死 4**：主公体力上限会 +1，临时改上限的技能也存在。 */
function lostHp(state: SanguoshaState, playerId: PlayerId): number {
  const owner = playerOf(state, playerId)
  return Math.max(0, owner.maxHp - owner.hp)
}

// ─────────────────────────────── 祸首 ───────────────────────────────

/**
 * 【祸首】首版原文：
 * 「锁定技，【南蛮入侵】对你无效；你是任何【南蛮入侵】造成的伤害的来源。」
 *
 * 后半在实现上写成「其他角色使用的【南蛮入侵】」，行为完全等价：
 * 孟获自己使用时来源本来就是他，改与不改没有可观察差别。
 *
 * 判断的是**有效牌名**而不是实体牌名——将来出现「把某张牌当南蛮用」的转化技时，
 * 祸首照样生效。牌名由结算管线一路传下来的 `cardName` 提供，那本来就是有效名。
 */
registerSkillRuntime({
  id: HUOSHOU,
  cardEffectInvalid(_state, _ownerId, _sourceId, cardName) {
    return cardName === '南蛮入侵'
  },
  modifyDamageSource(_state, ownerId, context) {
    if (context.cardName !== '南蛮入侵') return undefined
    // 孟获自己就是目标时不改（他对南蛮免疫，走到这里只可能是别的路径），
    // 也不要把「自己打自己」凭空造出来
    if (context.targetId === ownerId) return undefined
    if (context.sourceId === ownerId) return undefined
    return ownerId
  },
})

// ─────────────────────────────── 再起 ───────────────────────────────

/**
 * 【再起】首版原文：
 * 「摸牌阶段，若你已受伤，你可以放弃摸牌，改为亮出牌堆顶 X 张牌
 *   （X 为你已损失的体力值），其中每有一张红桃牌你回复 1 点体力，
 *   然后弃掉这些红桃牌，将其余的牌收入手牌。」
 *
 * 注意方向：**红桃换血、非红桃进手牌**，不是反过来。
 *
 * 是「替代摸牌」而不是「摸牌之外再亮牌」，所以走取消 DrawPhase 的约定：
 * 取消之后这个阶段的补牌完全由技能负责，放弃发动时由技能自己把两张摸回来。
 */
const ZAIQI_REASON = '再起'

/** 红桃判定读**有效花色**：小乔【红颜】这类花色改写对再起同样生效。 */
function isHeart(state: SanguoshaState, ownerId: PlayerId, cardId: string): boolean {
  return effectiveCardSuit(state, ownerId, cardId) === 'heart'
}

function runZaiqi(host: SkillHost, ownerId: PlayerId): void {
  const emit = (name: Parameters<SkillHost['dispatch']>[0], payload?: Record<string, unknown>): void => { host.dispatch(name, payload) }
  const count = lostHp(host.state, ownerId)
  const revealed = revealTopCards(host.state, host.rng, count, ZAIQI_REASON, emit)
  if (revealed.length === 0) return

  const hearts = revealed.filter((cardId) => isHeart(host.state, ownerId, cardId))
  const rest = revealed.filter((cardId) => !hearts.includes(cardId))

  host.dispatch('SkillActivated', {
    skillId: ZAIQI, skillName: ZAIQI_REASON, playerId: ownerId, result: 'reveal',
    cardIds: revealed,
    logText: `${playerOf(host.state, ownerId).nickname}发动【再起】，亮出 ${revealed.length} 张牌，其中红桃 ${hearts.length} 张`,
  }, { sourceId: ownerId, cardIds: revealed })

  // 红桃牌先进弃牌堆再回血：回血过程里可能有技能插手，牌得先落到确定的位置
  for (const cardId of hearts) {
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  }
  // 其余的牌收进手牌。亮过的牌是公开的，所以 GainCard 带 revealed
  if (rest.length > 0) {
    for (const cardId of rest) {
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
    }
    host.dispatch('GainCard', { playerId: ownerId, cardIds: rest, reason: ZAIQI_REASON, revealed: true }, { targetId: ownerId, cardIds: rest })
  }
  // 回复走公共入口：Recover 事件、界面和日志都靠它，直接 hp++ 会全丢
  for (let index = 0; index < hearts.length; index += 1) {
    const owner = playerOf(host.state, ownerId)
    if (!owner.alive || owner.hp >= owner.maxHp) break
    recover(host as never, ownerId, 1, ownerId)
  }
}

registerSkillRuntime({
  id: ZAIQI,
  announcesSelf: true,
  triggers: [{
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      // 已有技能占着发问位就让开，两个摸牌阶段技能不能同时接管（和裸衣、突袭同一条约定）
      if (host.state.skillResolution) return
      // 没受伤就不能发动，也不该弹出一个只能拒绝的窗口
      if (lostHp(host.state, ownerId) <= 0) return
      context.cancel()
      host.askSkill({
        skillId: ZAIQI, ownerId, step: 'ask',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `发动【再起】？放弃摸牌，改为亮出牌堆顶 ${lostHp(host.state, ownerId)} 张牌，每张红桃回复 1 点体力，其余收入手牌`,
          timeoutMs: 20_000, optional: false,
          options: [{ id: 'yes', label: '发动再起' }, { id: 'no', label: '正常摸两张牌' }],
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId: string }).optionId !== 'yes') {
      // 放弃发动就把这个阶段本该摸的牌补上——DrawPhase 事件已经被取消，引擎不会再摸
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
      return
    }
    runZaiqi(host, ownerId)
  },
})

export const MENGHUO: CharacterDefinition = {
  id: 'menghuo',
  name: '孟获',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'forest',
  skills: [
    {
      id: HUOSHOU,
      name: '祸首',
      description: '锁定技，【南蛮入侵】对你无效；其他角色使用的【南蛮入侵】造成伤害时，伤害来源视为你。',
    },
    {
      id: ZAIQI,
      name: '再起',
      description: '摸牌阶段，若你已受伤，你可以放弃摸牌，改为亮出牌堆顶 X 张牌（X 为你已损失的体力值）：每有一张红桃牌你回复 1 点体力并弃置该牌，其余的牌收入手牌。',
    },
  ],
}
