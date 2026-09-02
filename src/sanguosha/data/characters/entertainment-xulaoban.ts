import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import {
  closePrivateZone, moveIntoPrivateZone, moveOutOfPrivateZone, openPrivateZone, privateZoneCards,
} from '../../engine/private-zone'
import type { ChooseOptionRequest, ChooseTargetsRequest, GameResponse } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 好友娱乐包·许老板。
 *
 * 【空城计】是心理博弈：把全部手牌扣成「楼」，让别人赌里面随机一张是不是基本牌。
 * 【杠杆】是资源透支：现在多摸，下个摸牌阶段还，还不上就掉血。
 *
 * 三条实现上的硬约束：
 *
 * 1. **「楼」走私有区，不走处理区。** 处理区在 PlayerView 里是全公开的，
 *    把牌塞进去再让前端别显示，网络包里照样是明文。私有区是为这件事建的。
 * 2. **随机展示由服务端的 GameRng 决定。** 客户端不能自己随机，联机两端和重连
 *    前后必须是同一张牌。
 * 3. **「债」记在 `player.marks` 里**（那是个数字表，正好合适），跟着牌局状态
 *    序列化，重连不会丢也不会重复结算。
 */

export const KONGCHENGJI = 'kongchengji'
export const GANGGAN = 'ganggan'

/** 「债」的标记名。marks 是公开信息，座位卡上会显示。 */
export const DEBT_MARK = 'debt'

const GUESS_BASIC = 'kongchengji-basic'
const GUESS_OTHER = 'kongchengji-other'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 每个许老板一个「楼」，多个许老板同场时不会撞在一起。 */
function towerZoneId(ownerId: PlayerId): string {
  return `${KONGCHENGJI}:${ownerId}`
}

export function debtOf(state: SanguoshaState, playerId: PlayerId): number {
  return playerOf(state, playerId)?.marks[DEBT_MARK] ?? 0
}

function setDebt(state: SanguoshaState, playerId: PlayerId, value: number): void {
  const owner = playerOf(state, playerId)
  if (!owner) return
  if (value > 0) owner.marks[DEBT_MARK] = value
  else delete owner.marks[DEBT_MARK]
}

function drawFor(host: SkillHost, playerId: PlayerId, count: number, reason: string): void {
  if (count <= 0) return
  drawCards(host.state, host.rng, playerId, count, (name, payload) => {
    host.dispatch(name, { ...payload, reason })
  })
}

// ─────────────────────────────── 空城计 ───────────────────────────────

registerSkillRuntime({
  id: KONGCHENGJI,
  // 每一步都有自己的横幅文案（唱空城、猜中、被识破），引擎那条通用的会和它撞在一起
  announcesSelf: true,

  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, KONGCHENGJI)) return []
    return [{ id: `skill:${KONGCHENGJI}`, label: '发动【空城计】：扣置所有手牌，让一名角色猜其中一张是不是基本牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${KONGCHENGJI}`) throw new Error('空城计动作不匹配')
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    // 先记账：中途取消不能刷次数
    markUsedThisTurn(host.state, ownerId, KONGCHENGJI)

    // 真的没牌：这出空城是真的，直接摸一张
    if (owner.zones.hand.length === 0) {
      host.dispatch('SkillActivated', {
        skillId: KONGCHENGJI, skillName: '空城计', playerId: ownerId, result: 'empty',
        logText: `${owner.nickname}发动【空城计】：城里是真的空，摸一张牌`,
      }, { sourceId: ownerId })
      drawFor(host, ownerId, 1, KONGCHENGJI)
      return
    }

    const candidateIds = host.state.players
      .filter((player) => player.alive && player.id !== ownerId)
      .map((player) => player.id)
    // 场上只剩自己：没人可猜，按无手牌那条处理，别把牌扣进去收不回来
    if (candidateIds.length === 0) {
      host.dispatch('SkillActivated', {
        skillId: KONGCHENGJI, skillName: '空城计', playerId: ownerId, result: 'empty',
        logText: `${owner.nickname}发动【空城计】：无人可猜，摸一张牌`,
      }, { sourceId: ownerId })
      drawFor(host, ownerId, 1, KONGCHENGJI)
      return
    }

    const zoneId = towerZoneId(ownerId)
    openPrivateZone(host.state, zoneId, ownerId, KONGCHENGJI)
    const towered: CardId[] = []
    for (const cardId of [...owner.zones.hand]) {
      moveIntoPrivateZone(host.state, cardId, { kind: 'hand', playerId: ownerId }, zoneId)
      towered.push(cardId)
    }
    host.dispatch('SkillActivated', {
      skillId: KONGCHENGJI, skillName: '空城计', playerId: ownerId, result: 'tower', count: towered.length,
      logText: `${owner.nickname}巧施【空城计】，将 ${towered.length} 张手牌扣置为「楼」`,
    }, { sourceId: ownerId })

    host.askSkill({
      skillId: KONGCHENGJI,
      ownerId,
      step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId,
        kind: 'choose-targets',
        playerId: ownerId,
        prompt: '【空城计】：选择一名其他角色来猜',
        timeoutMs: 20_000,
        optional: false,
        candidateIds,
        min: 1,
        max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response: GameResponse) {
    const zoneId = towerZoneId(ownerId)

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
      const target = playerOf(host.state, targetId)
      if (!target?.alive || targetId === ownerId) {
        // 目标不合法（超时兜底选到了死人）：牌原样还回去，不让它卡在楼里
        returnTower(host, ownerId, null)
        return
      }
      host.askSkill({
        skillId: KONGCHENGJI,
        ownerId,
        step: 'guess',
        data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId,
          // 问的是**猜的人**，不是许老板
          kind: 'choose-option',
          playerId: targetId,
          prompt: '城里到底有没有东西？猜其中随机一张是不是基本牌',
          timeoutMs: 20_000,
          optional: false,
          options: [
            { id: GUESS_BASIC, label: '有：我猜是基本牌' },
            { id: GUESS_OTHER, label: '无：我猜不是基本牌' },
          ],
        }),
      })
      return
    }

    if (resolution.step !== 'guess') return
    const targetId = String(resolution.data.targetId ?? '')
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    const tower = privateZoneCards(host.state, zoneId)
    if (!owner?.alive || tower.length === 0) {
      returnTower(host, ownerId, null)
      return
    }

    /*
     * **随机展示牌由服务端选。**
     *
     * 走 host.rng 而不是 Math.random：同一个 seed 必须重放出同一张牌，
     * 联机两端、断线重连前后看到的结果才一致。
     */
    const revealedId = tower[host.rng.nextInt(tower.length)]
    const revealed = host.state.cards[revealedId]
    const isBasic = revealed?.category === 'basic'
    const guessedBasic = (response.payload as { optionId?: string }).optionId === GUESS_BASIC
    const correct = guessedBasic === isBasic

    // 展示这一张：先进处理区公开亮出来，其余「楼」仍然不泄露
    moveOutOfPrivateZone(host.state, revealedId, zoneId, { kind: 'processingArea' })
    host.dispatch('CardMove', {
      playerId: ownerId, cardIds: [revealedId], reason: KONGCHENGJI, revealed: true,
      guessedBasic, isBasic, correct,
    }, { sourceId: ownerId, targetId, cardIds: [revealedId] })

    if (correct) {
      // 猜对：这张牌归猜的人，其余收回
      moveCard(host.state, revealedId, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', {
        playerId: targetId, cardIds: [revealedId], reason: KONGCHENGJI,
      }, { targetId, cardIds: [revealedId] })
      host.dispatch('SkillActivated', {
        skillId: KONGCHENGJI, skillName: '空城计', playerId: ownerId, targetIds: [targetId], result: 'seen',
        logText: `${target?.nickname ?? ''}猜对了，【空城计】被识破，获得展示的【${revealed?.name ?? ''}】`,
      }, { sourceId: ownerId, targetId })
      returnTower(host, ownerId, null)
      return
    }

    // 猜错：全部收回，再摸两张
    returnTower(host, ownerId, revealedId)
    host.dispatch('SkillActivated', {
      skillId: KONGCHENGJI, skillName: '空城计', playerId: ownerId, targetIds: [targetId], result: 'won',
      logText: `${target?.nickname ?? ''}猜错了，【空城计】成功，${owner.nickname}收回所有「楼」并摸两张牌`,
    }, { sourceId: ownerId, targetId })
    drawFor(host, ownerId, 2, KONGCHENGJI)
  },
})

/**
 * 把「楼」收回许老板手里并关掉私有区。
 *
 * `extraId` 是已经被移到处理区的那张展示牌，猜错时它也要一起回来。
 * 许老板中途死掉时 `closePrivateZone` 会把剩下的牌送进弃牌堆——
 * 牌不会凭空消失，也不会留在一个没人能碰的区里。
 */
function returnTower(host: SkillHost, ownerId: PlayerId, extraId: CardId | null): void {
  const zoneId = towerZoneId(ownerId)
  const owner = playerOf(host.state, ownerId)
  const returned: CardId[] = []
  if (owner?.alive) {
    for (const cardId of [...privateZoneCards(host.state, zoneId)]) {
      moveOutOfPrivateZone(host.state, cardId, zoneId, { kind: 'hand', playerId: ownerId })
      returned.push(cardId)
    }
    if (extraId) {
      moveCard(host.state, extraId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      returned.push(extraId)
    }
  } else if (extraId) {
    moveCard(host.state, extraId, { kind: 'processingArea' }, { kind: 'discardPile' })
  }
  closePrivateZone(host.state, zoneId)
  if (returned.length === 0) return
  // 收回的是自己本来就有的牌，不广播牌面
  host.dispatch('GainCard', {
    playerId: ownerId, cardIds: returned, reason: KONGCHENGJI,
  }, { targetId: ownerId, cardIds: returned })
}

// ─────────────────────────────── 杠杆 ───────────────────────────────

const BORROW_PREFIX = 'ganggan-borrow:'

registerSkillRuntime({
  id: GANGGAN,
  announcesSelf: true,

  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, GANGGAN)) return []
    return [{ id: `skill:${GANGGAN}`, label: '发动【杠杆】：摸至多三张牌，并获得等量「债」' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${GANGGAN}`) throw new Error('杠杆动作不匹配')
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    markUsedThisTurn(host.state, ownerId, GANGGAN)
    host.askSkill({
      skillId: GANGGAN,
      ownerId,
      step: 'amount',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId,
        kind: 'choose-option',
        playerId: ownerId,
        prompt: `【杠杆】：借几张？下个摸牌阶段每有 1 枚「债」就少摸一张（当前 ${debtOf(host.state, ownerId)} 债）`,
        timeoutMs: 20_000,
        optional: true,
        options: [
          { id: `${BORROW_PREFIX}1`, label: '借 1 张：小借一点' },
          { id: `${BORROW_PREFIX}2`, label: '借 2 张：做大做强' },
          { id: `${BORROW_PREFIX}3`, label: '借 3 张：再加一点杠杆' },
          { id: 'cancel', label: '取消' },
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response: GameResponse) {
    if (resolution.step !== 'amount') return
    const optionId = String((response.payload as { optionId?: string }).optionId ?? '')
    if (!optionId.startsWith(BORROW_PREFIX)) return
    const amount = Number(optionId.slice(BORROW_PREFIX.length))
    if (!Number.isInteger(amount) || amount < 1 || amount > 3) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    drawFor(host, ownerId, amount, GANGGAN)
    setDebt(host.state, ownerId, debtOf(host.state, ownerId) + amount)
    host.dispatch('SkillActivated', {
      skillId: GANGGAN, skillName: '杠杆', playerId: ownerId, result: 'borrow', amount,
      logText: `${owner.nickname}发动【杠杆】，摸 ${amount} 张牌并获得 ${amount} 枚「债」`,
    }, { sourceId: ownerId })
  },

  triggers: [
    {
      /*
       * 还债：从这个摸牌阶段**最终应摸的张数**里扣。
       *
       * 优先级压低，让改摸牌数的技能先算完——规则要求以「最终正常应摸数量」
       * 为基础，而不是写死 2 张。这里改的是事件里的 count，引擎会照它摸牌，
       * 不接管整个摸牌阶段，别的技能该怎么插还怎么插。
       */
      event: 'DrawPhase',
      priority: -100,
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; count?: number }
        if (payload.playerId !== ownerId) return
        const debt = debtOf(host.state, ownerId)
        if (debt <= 0) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return

        const normal = Math.max(0, Number(payload.count ?? 0))
        const repaid = Math.min(normal, debt)
        payload.count = normal - repaid
        setDebt(host.state, ownerId, debt - repaid)
        host.dispatch('SkillActivated', {
          skillId: GANGGAN, skillName: '杠杆', playerId: ownerId, result: 'repay', amount: repaid,
          logText: `${owner.nickname}因【杠杆】少摸 ${repaid} 张牌`,
        }, { sourceId: ownerId })
      },
    },
    {
      /*
       * 摸牌阶段结束后还欠着就掉一点体力，然后一笔勾销。
       *
       * **跳过的摸牌阶段不会走到这里**：引擎跳过阶段时既不发 PhaseStart 也不发
       * PhaseEnd，所以「摸牌阶段被跳过则债保留、不掉血」是自然成立的，
       * 不需要额外判断。
       *
       * 用 queueSkill 而不是当场扣血：这里正处在阶段切换中间，当场掉到 0
       * 会把濒死流程塞进阶段推进里。排队等牌局干净了再扣，等价而安全。
       */
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'draw' || payload.playerId !== ownerId) return
        if (debtOf(host.state, ownerId) <= 0) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.queueSkill({ skillId: GANGGAN, ownerId, step: 'settle', data: {} })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'settle') return
    const debt = debtOf(host.state, ownerId)
    if (debt <= 0) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.dispatch('SkillActivated', {
      skillId: GANGGAN, skillName: '杠杆', playerId: ownerId, result: 'default', amount: debt,
      logText: `${owner.nickname}资金链有点紧张：还欠 ${debt} 枚「债」，失去 1 点体力并清空债务`,
    }, { sourceId: ownerId })
    // 无论欠 1 枚还是 3 枚都只掉一点，而且是**失去体力**不是伤害：
    // 奸雄、遗计、刚烈、狂骨都不该被触发
    setDebt(host.state, ownerId, 0)
    loseHp(host, ownerId, 1, GANGGAN)
  },
})

export const XULAOBAN: CharacterDefinition = {
  id: 'xulaoban',
  name: '许老板',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'entertainment',
  skills: [
    {
      id: KONGCHENGJI,
      name: '空城计',
      description: '出牌阶段限一次，你可以将所有手牌扣置为“楼”，令一名其他角色猜测其中随机展示的一张牌是否为基本牌。若其猜错，你收回所有“楼”并摸两张牌；若猜对，其获得展示牌，你收回其余“楼”。若你没有手牌，则改为摸一张牌。',
    },
    {
      id: GANGGAN,
      name: '杠杆',
      description: '出牌阶段限一次，你可以摸至多三张牌，并获得等量“债”。你的下一个摸牌阶段每有1枚“债”，便少摸一张牌并移去1枚“债”；摸牌阶段结束后若仍有“债”，你失去1点体力并清除所有“债”。',
    },
  ],
}
