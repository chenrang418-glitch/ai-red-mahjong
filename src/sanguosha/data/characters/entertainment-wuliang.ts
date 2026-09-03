import { checkIdentityVictory } from '../../engine/modes/identity'
import { recover } from '../../engine/recover'
import type { ChooseOptionRequest, GameResponse } from '../../engine/requests'
import {
  RENNAI_MARK, RENNAI_MAX, RENNAI_SKILL, consumeRennai, isRennaiArmed, noteRennaiHarm, rennaiCount, setRennaiCount,
} from '../../engine/rennai'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 好友娱乐包·无亮。
 *
 * 网络二创梗角色，玩法是「先挨打攒资本，攒够了直接换身份」。
 * 文案一律停留在牌桌上，不写现实事件。
 *
 * 三条实现上的硬约束：
 *
 * 1. **「本来可以响应」由求牌路径判断**，不在这里猜。三条求牌路径（求闪、
 *    锦囊效果求牌、无懈轮询）自己最清楚当前有没有合法响应，`engine/rennai.ts`
 *    只提供公共判断，武将文件不重复实现一套。
 * 2. **「忍」只在真的吃亏之后才加**。放弃响应之后挂一个 armed 标记，牌结算完
 *    （AfterCardUse）才结账——伤害被防止、锦囊被无懈掉的场合一枚都不给。
 * 3. **【夺位】真的交换身份**，不是给一个「伪主公」标记。胜利判定本来就每次
 *    从 `player.identity` 现算，所以换完立刻按新身份生效，没有阵营缓存要刷。
 */

export const RENNAI = RENNAI_SKILL
export const DUOWEI = 'duowei'

/** 忍的枚数就是座位卡上的标记。 */
export const RENNAI_COUNT_MARK = RENNAI_MARK

const DUOWEI_INVOKE = 'duowei-invoke'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function lordOf(state: SanguoshaState) {
  return state.players.find((player) => player.identity === 'lord')
}

/** 连续忍到第几枚时说什么。纯表现，不影响任何数值。 */
function endureText(count: number): string {
  if (count >= 4) return '时机已到。'
  if (count === 3) return '快了。'
  if (count === 2) return '继续忍。'
  return '再等等。'
}

// ─────────────────────────────── 忍耐 ───────────────────────────────

/**
 * 结算一次「忍」。
 *
 * 只有确实吃到负面结果才给：伤害被防止、牌被无懈掉、目标被转移走的场合，
 * armed 标记照样清掉，但一枚忍都不加。
 */
function settleRennai(host: SkillHost, ownerId: PlayerId): void {
  const hurt = consumeRennai(host.state, ownerId)
  const owner = playerOf(host.state, ownerId)
  if (!hurt || !owner?.alive) return

  const before = rennaiCount(host.state, ownerId)
  setRennaiCount(host.state, ownerId, before + 1)
  const after = rennaiCount(host.state, ownerId)

  host.dispatch('SkillActivated', {
    skillId: RENNAI, skillName: '忍耐', playerId: ownerId, result: 'gain', count: after,
    logText: `${owner.nickname}获得 1 枚「忍」（${after}/${RENNAI_MAX}）：${endureText(after)}`,
  }, { sourceId: ownerId })

  stealFromLord(host, ownerId)
}

/**
 * 从主公手里随机抽一张给无亮。
 *
 * **随机由服务端的 GameRng 决定**，无亮不能先看主公手牌再挑；牌面也不进战报，
 * 公开日志只说「随机获得主公一张手牌」。
 *
 * 主公就是无亮自己时直接跳过——不能从自己手里拿牌给自己。
 */
function stealFromLord(host: SkillHost, ownerId: PlayerId): void {
  const lord = lordOf(host.state)
  if (!lord?.alive || lord.id === ownerId || lord.zones.hand.length === 0) return
  const cardId: CardId = lord.zones.hand[host.rng.nextInt(lord.zones.hand.length)]
  moveCard(host.state, cardId, { kind: 'hand', playerId: lord.id }, { kind: 'hand', playerId: ownerId })
  host.dispatch('LoseCard', { playerId: lord.id, cardIds: [cardId], reason: RENNAI }, { targetId: lord.id })
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: RENNAI }, { targetId: ownerId })
  host.dispatch('SkillActivated', {
    skillId: RENNAI, skillName: '忍耐', playerId: ownerId, targetIds: [lord.id], result: 'steal',
    logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}随机获得主公一张手牌`,
  }, { sourceId: ownerId, targetId: lord.id })
}

/** 这些事件落在无亮身上就算「吃亏了」。 */
const HARM_EVENTS = ['Damaged', 'LoseHp', 'LoseCard', 'LoseEquipment', 'CharacterFlip'] as const

registerSkillRuntime({
  id: RENNAI,
  announcesSelf: true,

  triggers: [
    ...HARM_EVENTS.map((event) => ({
      event,
      handle(host: SkillHost, ownerId: PlayerId, context: { event: { payload: Record<string, unknown>; targetId?: PlayerId } }) {
        if (!isRennaiArmed(host.state, ownerId)) return
        const payload = context.event.payload as { playerId?: PlayerId }
        const affected = payload.playerId ?? context.event.targetId
        if (affected !== ownerId) return
        // 忍耐自己拿主公牌那一下也会发 GainCard/LoseCard，但那是收益不是伤害，
        // 而且发生在结账之后，armed 早就清了，不会误判
        noteRennaiHarm(host.state, ownerId)
      },
    })),
    {
      /*
       * 结账放在整张牌结算完之后。
       *
       * 伤害可能被防具、技能挡掉，锦囊可能被无懈掉，目标还可能被流离转走——
       * 只有走到这里才知道这次忍到底亏没亏。
       */
      event: 'AfterCardUse',
      handle(host, ownerId) {
        if (!isRennaiArmed(host.state, ownerId)) return
        settleRennai(host, ownerId)
      },
    },
  ],
})

// ─────────────────────────────── 夺位 ───────────────────────────────

/** 主公体力是否已经掉到上限的一半（上限为奇数时向下取整）。 */
function lordIsWeak(state: SanguoshaState): boolean {
  const lord = lordOf(state)
  return Boolean(lord?.alive && lord.hp <= Math.floor(lord.maxHp / 2))
}

export function canInvokeDuowei(state: SanguoshaState, ownerId: PlayerId): boolean {
  // 没有主公的模式不给发动，也不为了支持它们凭空造一个主公
  if (state.setup.mode !== 'identity' || state.status !== 'playing') return false
  const owner = playerOf(state, ownerId)
  if (!owner?.alive || owner.usedLimitedSkills.includes(DUOWEI)) return false
  if (owner.identity === 'lord') return false
  const lord = lordOf(state)
  if (!lord?.alive || lord.id === ownerId) return false
  if (rennaiCount(state, ownerId) < RENNAI_MAX) return false
  return lordIsWeak(state)
}

/**
 * 交换身份。
 *
 * 只换身份牌，不换武将、技能、手牌、装备、判定区、座位和体力值本身。
 * 主公那 1 点额外体力上限跟着身份走：用**相对增减**而不是按武将重算，
 * 免得把别的效果留下的上限修正一起抹掉。
 */
function swapIdentityWithLord(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  const lord = lordOf(host.state)
  if (!owner || !lord) return

  const ownIdentity = owner.identity
  owner.identity = 'lord'
  lord.identity = ownIdentity

  // 身份局固定 5~8 人，主公上限 +1 一定存在；仍然按同一个条件判断，不写死
  const hasLordBonus = host.state.players.length >= 5
  if (hasLordBonus) {
    owner.maxHp += 1
    lord.maxHp = Math.max(1, lord.maxHp - 1)
    if (lord.hp > lord.maxHp) lord.hp = lord.maxHp
  }
  // 交换是全场可见的，两边的身份从此都是公开信息
  owner.identityRevealed = true
  lord.identityRevealed = true
}

registerSkillRuntime({
  id: DUOWEI,
  announcesSelf: true,

  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      if (!canInvokeDuowei(host.state, ownerId)) return
      host.queueSkill({ skillId: DUOWEI, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    // 排队期间局势可能变了（主公被治好、主公死了、牌局结束）
    if (!canInvokeDuowei(host.state, ownerId)) return
    const lord = lordOf(host.state)
    host.askSkill({
      skillId: DUOWEI,
      ownerId,
      step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId,
        kind: 'choose-option',
        playerId: ownerId,
        prompt: `时机已到，是否发动【夺位】与${lord?.nickname ?? '主公'}交换身份？`,
        timeoutMs: 20_000,
        optional: true,
        options: [
          { id: DUOWEI_INVOKE, label: '夺位：与主公交换身份' },
          { id: 'cancel', label: '继续忍' },
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response: GameResponse) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== DUOWEI_INVOKE) return
    if (!canInvokeDuowei(host.state, ownerId)) return

    const owner = playerOf(host.state, ownerId)!
    const lord = lordOf(host.state)!
    // 限定技：一局一次，永不重置
    owner.usedLimitedSkills.push(DUOWEI)

    host.dispatch('SkillActivated', {
      skillId: DUOWEI, skillName: '夺位', playerId: ownerId, targetIds: [lord.id], result: 'swap',
      logText: `${owner.nickname}发动【夺位】，与${lord.nickname}交换了身份，成为新的主公`,
    }, { sourceId: ownerId, targetId: lord.id })

    swapIdentityWithLord(host, ownerId)
    setRennaiCount(host.state, ownerId, 0)
    if (owner.alive && owner.hp < owner.maxHp) recover(host, ownerId, 1, ownerId)

    /*
     * 换完立刻重算胜负。
     *
     * 胜利判定本来就每次从 `player.identity` 现算，没有阵营缓存；但换身份本身
     * 可能当场满足结束条件（比如无亮是最后一名反贼，换成主公后场上再没有
     * 反贼和内奸），必须在这里结一次，不能等到下一次有人死亡。
     */
    const result = checkIdentityVictory(host.state.players)
    if (result) {
      host.state.result = result
      host.state.status = 'game-over'
      for (const candidate of host.state.players) candidate.identityRevealed = true
      host.state.pendingRequests = []
    }
  },
})

export const WULIANG: CharacterDefinition = {
  id: 'wuliang',
  name: '无亮',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'entertainment',
  skills: [
    {
      id: RENNAI,
      name: '忍耐',
      description: '每回合限一次，当你成为其他角色使用的【杀】或普通锦囊牌的目标时，若你可以响应，你可以放弃响应；若你因此受到伤害或负面效果，你获得1枚“忍”（至多4枚），并随机获得主公一张手牌。',
    },
    {
      id: DUOWEI,
      name: '夺位',
      description: '限定技，准备阶段，若你有4枚“忍”且主公体力值不大于其体力上限的一半，你可以与主公交换身份，清除所有“忍”，然后增加1点体力上限并回复1点体力。',
    },
  ],
}
