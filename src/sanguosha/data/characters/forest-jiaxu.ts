import { getDistance } from '../../engine/distance'
import { loseHp } from '../../engine/hp'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { effectiveCardColor, registerSkillRuntime, skillsOf, type SkillHost } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { setCardAlias } from '../../engine/zones'
import { skillIdsOf } from './standard'
import type { CharacterDefinition } from './types'

/**
 * 林包·贾诩。经典「神话再临·林」首版，3 体力。
 *
 * 【完杀】「锁定技，你的回合内，当一名角色进入濒死状态时，
 *   你令除你和其以外的角色不能对其使用【桃】直到此次濒死结算结束。」
 * 【乱武】「限定技，出牌阶段，你可以令所有其他角色依次选择一项：
 *   1.对其攻击范围内距离最近的另一名角色使用一张【杀】；2.失去 1 点体力。」
 * 【帷幕】「锁定技，你不能成为黑色锦囊牌的目标。」
 *
 * 帷幕是**不能成为目标**（`prohibitsTarget`），和孟获【祸首】、祝融【巨象】的
 * 「成为目标但效果无效」是两个概念：帷幕在生成动作时就把贾诩排除掉了，
 * 全体锦囊也一样——他根本不在那张牌的目标列表里。
 */

export const WANSHA = 'wansha'
export const LUANWU = 'luanwu'
export const WEIMU = 'weimu'

/** 延时锦囊也是锦囊。帷幕挡的是「锦囊牌」，两类都要算。 */
const DELAYED_TRICK_NAMES = new Set(['乐不思蜀', '兵粮寸断', '闪电'])

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 完杀 ───────────────────────────────

/**
 * 锁定技。只在**贾诩自己的回合内**生效，回合外完全没有效果。
 *
 * 读的是 `currentPlayerId`，不是缓存下来的回合持有者：额外回合、翻面跳过
 * 这些情况都只有它是准的。
 *
 * 例外的两个人：**濒死者本人**和**贾诩自己**照常能用桃。
 * 限制的只有【桃】——濒死角色用【酒】自救是另一条规则，不受影响，
 * 不屈、涅槃更是技能而不是牌，完杀碰不到它们。
 */
registerSkillRuntime({
  id: WANSHA,
  prohibitsCardUse(state, ownerId, context) {
    if (context.cardName !== '桃') return false
    const owner = playerOf(state, ownerId)
    // 贾诩死了技能就没了
    if (!owner?.alive) return false
    // 只在贾诩的回合内
    if (state.currentPlayerId !== ownerId) return false
    // 没有人濒死就无从限制
    if (!context.dyingPlayerId) return false
    // 贾诩自己和当前濒死者不受限
    if (context.userId === ownerId || context.userId === context.dyingPlayerId) return false
    return true
  },
})

// ─────────────────────────────── 帷幕 ───────────────────────────────

/**
 * 锁定技，不能成为**黑色锦囊牌**的目标。
 *
 * 颜色读 `effectiveCardColor`，而且读的是**实体牌**：转化技（甘宁【奇袭】把黑牌
 * 当过河拆桥、徐晃【断粮】把黑牌当兵粮寸断）用的仍然是那张黑牌，所以帷幕挡得住；
 * 卧龙【火计】拿红牌当火攻，实体牌是红的，帷幕挡不住。这一条是项目里
 * 「转化牌是什么颜色」的唯一口径，不能改成看牌名或者印刷颜色。
 *
 * 只挡锦囊：黑色的【杀】、黑色装备、黑色基本牌都照常。
 */
registerSkillRuntime({
  id: WEIMU,
  prohibitsTarget(state, ownerId, _sourceId, cardName, cardId) {
    if (!INSTANT_TRICKS.has(cardName) && !DELAYED_TRICK_NAMES.has(cardName)) return false
    // 没有实体牌（纯技能生成的虚拟牌）时无从判断颜色，按不挡处理
    if (!cardId || !state.cards[cardId]) return false
    return effectiveCardColor(state, ownerId, cardId) === 'black'
  },
})

// ─────────────────────────────── 乱武 ───────────────────────────────

const LUANWU_SLASH = 'luanwu-slash'
const LUANWU_LOSE_HP = 'luanwu-lose-hp'

/**
 * 从贾诩的下家开始的座次顺序。「依次」按回合顺序走，不按 id 排序。
 */
function participantOrder(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const order: PlayerId[] = []
  for (let offset = 1; offset < state.players.length; offset += 1) {
    const candidate = state.players[(owner.seat + offset) % state.players.length]
    if (candidate.id !== ownerId) order.push(candidate.id)
  }
  return order
}

/**
 * 这名角色现在能对谁出这张【杀】。
 *
 * 两个条件叠加，缺一不可：
 *
 * 1. **距离最近**。并列最近的都是候选，由玩家自己挑一个，不由服务端定。
 * 2. **在攻击范围内**。官方裁定：最近的人如果超出攻击范围，就只能失去体力。
 *    所以这里先按距离取最小，再看这个距离是否够得着。
 *
 * 每轮到一个人都**重新算**：前面的人可能已经死了、装备可能已经离场，
 * 距离随时在变，不能用发动乱武那一刻的快照。
 */
function nearestReachableTargets(state: SanguoshaState, actorId: PlayerId): PlayerId[] {
  const others = state.players.filter((player) => player.alive && player.id !== actorId)
  if (others.length === 0) return []
  const distances = others.map((player) => ({ id: player.id, distance: getDistance(state, actorId, player.id) }))
  const nearest = Math.min(...distances.map((entry) => entry.distance))
  const range = attackRange(state, actorId)
  if (nearest > range) return []
  return distances.filter((entry) => entry.distance === nearest).map((entry) => entry.id)
}

/** 攻击范围：武器给的范围，没武器就是 1。 */
function attackRange(state: SanguoshaState, playerId: PlayerId): number {
  const owner = playerOf(state, playerId)
  const weapon = owner?.zones.equipment.weapon
  return weapon ? state.cards[weapon]?.attackRange ?? 1 : 1
}

/**
 * 这名角色手上哪些牌能当【杀】用。
 *
 * 实体【杀】之外，还要算上转化技（关羽【武圣】、赵云【龙胆】）能变成杀的牌——
 * **直接问各技能的 `viewAs`**，不自己维护一份「哪些武将能转杀」的名单，
 * 那种名单加一个武将就会漏。
 */
function slashCardIds(state: SanguoshaState, actorId: PlayerId): Array<{ cardId: CardId; converted: boolean }> {
  const actor = playerOf(state, actorId)
  if (!actor) return []
  const converted = new Set(
    skillsOf(state, actorId, skillIdsOf)
      .flatMap((runtime) => runtime.viewAs?.(state, actorId) ?? [])
      .filter((option) => option.asCardName === '杀')
      .map((option) => option.cardId),
  )
  return actor.zones.hand
    .filter((cardId) => state.cards[cardId]?.name === '杀' || converted.has(cardId))
    .map((cardId) => ({ cardId, converted: state.cards[cardId]?.name !== '杀' }))
}

/** 排下一位参与者。轮到时重新确认前提，中途死掉的直接跳过。 */
function queueNext(host: SkillHost, ownerId: PlayerId, order: readonly PlayerId[], index: number): void {
  for (let next = index; next < order.length; next += 1) {
    const actor = playerOf(host.state, order[next])
    if (!actor?.alive) continue
    /*
     * `ownerId` 挂在**当前这名参与者**身上，不是贾诩。
     *
     * 引擎抽干队列时会跳过「拥有者已死」的排队项：挂贾诩的话，
     * 他在乱武中途被人砍死，剩下的人就全被跳过了。挂参与者本人更贴规则。
     */
    host.queueSkill({ skillId: LUANWU, ownerId: actor.id, step: 'act', data: { luanwuOwnerId: ownerId, order: [...order], index: next } })
    return
  }
}

registerSkillRuntime({
  id: LUANWU,
  limited: true,
  announcesSelf: true,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    // 限定技：一局一次，永不重置
    if (owner.usedLimitedSkills.includes(LUANWU)) return []
    if (participantOrder(state, ownerId).filter((id) => playerOf(state, id)?.alive).length === 0) return []
    return [{ id: `skill:${LUANWU}`, label: '发动【乱武】：令所有其他角色依次出杀或失去一点体力' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${LUANWU}`) return
    const owner = playerOf(host.state, ownerId)
    if (!owner || owner.usedLimitedSkills.includes(LUANWU)) return
    owner.usedLimitedSkills.push(LUANWU)
    host.dispatch('SkillActivated', {
      skillId: LUANWU, skillName: '乱武', playerId: ownerId, result: 'start',
      logText: `${owner.nickname}发动限定技【乱武】`,
    }, { sourceId: ownerId })
    queueNext(host, ownerId, participantOrder(host.state, ownerId), 0)
  },
  startQueued(host, actorId, prompt) {
    const luanwuOwnerId = prompt.data.luanwuOwnerId as PlayerId
    const order = prompt.data.order as PlayerId[]
    const index = prompt.data.index as number
    const actor = playerOf(host.state, actorId)
    if (!actor?.alive) {
      queueNext(host, luanwuOwnerId, order, index + 1)
      return
    }

    const targets = nearestReachableTargets(host.state, actorId)
    const usable = slashCardIds(host.state, actorId)
    if (targets.length === 0 || usable.length === 0) {
      // 打不出杀就只能失去体力，不弹一个只有一个选项的窗口
      luanwuLoseHp(host, actorId, luanwuOwnerId, order, index)
      return
    }
    host.askSkill({
      skillId: LUANWU, ownerId: actorId, step: 'choose',
      data: { luanwuOwnerId, order, index },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: actorId,
        prompt: `【乱武】：对距离最近的${targets.map((id) => playerOf(host.state, id)?.nickname).join('、')}使用一张【杀】，或失去 1 点体力`,
        // 强制选择，不能放弃
        timeoutMs: 25_000, optional: false,
        options: [
          { id: LUANWU_SLASH, label: '使用一张【杀】' },
          { id: LUANWU_LOSE_HP, label: '失去 1 点体力' },
        ],
      }),
    })
  },
  resume(host, actorId, resolution, response) {
    const luanwuOwnerId = resolution.data.luanwuOwnerId as PlayerId
    const order = resolution.data.order as PlayerId[]
    const index = resolution.data.index as number

    if (resolution.step === 'choose') {
      if ((response.payload as { optionId: string }).optionId !== LUANWU_SLASH) {
        luanwuLoseHp(host, actorId, luanwuOwnerId, order, index)
        return
      }
      // 目标要**现算**：刚才那一问的中间牌局没动，但保持同一条纪律
      const targets = nearestReachableTargets(host.state, actorId)
      if (targets.length === 0) {
        luanwuLoseHp(host, actorId, luanwuOwnerId, order, index)
        return
      }
      if (targets.length === 1) {
        askLuanwuCard(host, actorId, targets[0], luanwuOwnerId, order, index)
        return
      }
      host.askSkill({
        skillId: LUANWU, ownerId: actorId, step: 'target',
        data: { luanwuOwnerId, order, index },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: actorId,
          prompt: '【乱武】：这几名角色距离相同，选择一个作为【杀】的目标',
          timeoutMs: 20_000, optional: false,
          candidateIds: targets, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
      askLuanwuCard(host, actorId, targetId, luanwuOwnerId, order, index)
      return
    }

    if (resolution.step === 'card') {
      const targetId = resolution.data.targetId as PlayerId
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      luanwuSlash(host, actorId, targetId, cardId, luanwuOwnerId, order, index)
    }
  },
})

/** 只有一张能当杀的牌就不多问一步；有多张让玩家自己挑。 */
function askLuanwuCard(host: SkillHost, actorId: PlayerId, targetId: PlayerId, luanwuOwnerId: PlayerId, order: readonly PlayerId[], index: number): void {
  const usable = slashCardIds(host.state, actorId)
  if (usable.length === 0) {
    luanwuLoseHp(host, actorId, luanwuOwnerId, order, index)
    return
  }
  if (usable.length === 1) {
    luanwuSlash(host, actorId, targetId, usable[0].cardId, luanwuOwnerId, order, index)
    return
  }
  const target = playerOf(host.state, targetId)
  host.askSkill({
    skillId: LUANWU, ownerId: actorId, step: 'card',
    data: { luanwuOwnerId, order, index, targetId },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: actorId,
      prompt: `【乱武】：选择一张当【杀】用的牌，目标${target?.nickname ?? ''}`,
      timeoutMs: 20_000, optional: false, purpose: 'skill',
      cardIds: usable.map((entry) => entry.cardId), hiddenCardSlots: [],
      min: 1, max: 1,
    }),
  })
}

/** 失去 1 点体力，然后接着下一个人。 */
function luanwuLoseHp(host: SkillHost, actorId: PlayerId, luanwuOwnerId: PlayerId, order: readonly PlayerId[], index: number): void {
  const actor = playerOf(host.state, actorId)
  if (actor?.alive) {
    host.dispatch('SkillActivated', {
      skillId: LUANWU, skillName: '乱武', playerId: actorId, result: 'lose-hp',
      logText: `${actor.nickname}选择失去 1 点体力`,
    }, { sourceId: actorId })
    // 失去体力**不是**受到伤害；掉到 0 时由 loseHp 统一进濒死
    loseHp(host, actorId, 1, '乱武')
  }
  /*
   * 排队而不是直接接着跑下一个：上面这一下可能把人打进濒死，
   * 濒死结算（含完杀限制下的求桃）要先走完。队列本来就是「等牌局干净了再放」。
   */
  queueNext(host, luanwuOwnerId, order, index + 1)
}

/** 走完整的【杀】管线，然后接着下一个人。 */
function luanwuSlash(host: SkillHost, actorId: PlayerId, targetId: PlayerId, cardId: CardId, luanwuOwnerId: PlayerId, order: readonly PlayerId[], index: number): void {
  const actor = playerOf(host.state, actorId)
  const target = playerOf(host.state, targetId)
  if (!actor?.alive || !target?.alive || !actor.zones.hand.includes(cardId)) {
    queueNext(host, luanwuOwnerId, order, index + 1)
    return
  }
  // 转化技换来的杀：先把「当作【杀】用」记下来，公共管线按有效牌名认它
  if (host.state.cards[cardId]?.name !== '杀') setCardAlias(host.state, cardId, '杀')
  host.dispatch('SkillActivated', {
    skillId: LUANWU, skillName: '乱武', playerId: actorId, targetIds: [targetId], result: 'slash',
    logText: `${actor.nickname}对${target.nickname}使用【杀】`,
  }, { sourceId: actorId, targetId })
  /*
   * **伤害来源是出杀的人，不是贾诩。** 贾诩只是逼他出杀。
   * 走公共的虚拟杀入口，所以闪、八卦、无双、烈刃这些照常生效；
   * 距离和出杀次数不再检查——目标合法性上面已经按「最近且在攻击范围内」算过了。
   */
  host.beginVirtualSlash({ sourceId: actorId, targetId, sourceSkillId: LUANWU, cardId })
  queueNext(host, luanwuOwnerId, order, index + 1)
}

export const JIAXU: CharacterDefinition = {
  id: 'jiaxu',
  name: '贾诩',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'forest',
  skills: [
    { id: WANSHA, name: '完杀', description: '锁定技，你的回合内，当一名角色进入濒死状态时，除你和该角色外的其他角色不能对其使用【桃】。' },
    { id: LUANWU, name: '乱武', description: '限定技，出牌阶段，你可以令所有其他角色依次选择一项：对其攻击范围内距离最近的另一名角色使用一张【杀】，或失去 1 点体力。' },
    { id: WEIMU, name: '帷幕', description: '锁定技，你不能成为黑色锦囊牌的目标。' },
  ],
}
