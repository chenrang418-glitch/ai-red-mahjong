import { suppressArmor } from '../../engine/armor-suppression'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { flipCharacter } from '../../engine/character-state'
import { loseHp } from '../../engine/hp'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, replaceTemporarySkill } from '../../engine/skills/runtime'
import { resolveDamage } from '../../engine/damage'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { CharacterDefinition } from './types'

/**
 * 神吕布。经典「神话再临·神」。
 *
 * 【狂暴】：锁定技，游戏开始时你获得 2 枚「暴怒」；此后每当你造成或受到 1 点伤害后，你获得 1 枚「暴怒」。
 * 【无谋】：锁定技，每当你使用一张非延时锦囊牌，你须移去 1 枚「暴怒」或失去 1 点体力。
 * 【无前】：出牌阶段，你可以移去 2 枚「暴怒」并选择一名其他角色：
 *   直到回合结束，你拥有【无双】，且该角色的防具技能无效。
 * 【神愤】：出牌阶段限一次，你可以移去 6 枚「暴怒」：对所有其他角色各造成 1 点伤害；
 *   然后所有其他角色弃置装备区所有牌；然后所有其他角色弃置四张手牌；然后你将武将牌翻面。
 */

const KUANGBAO = 'kuangbao'
const WUMOU = 'wumou'
const WUQIAN = 'wuqian'
const SHENFEN = 'shenfen'

/** 「暴怒」标记。和梦魇、忍共用公共的 `player.marks`，自然进 UI、序列化、联机同步。 */
export const RAGE_MARK = 'rage'

/**
 * 会触发【无谋】的牌名：全部非延时锦囊。
 *
 * 【无懈可击】也在内——它是非延时锦囊，按经典规则使用它同样要付代价。
 * 延时锦囊（乐不思蜀、兵粮寸断、闪电）不触发。
 */
const NON_DELAYED_TRICKS = new Set([...INSTANT_TRICKS, '无懈可击'])

const WUQIAN_COST = 2
const SHENFEN_COST = 6
const SHENFEN_DISCARD = 4

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function rageOf(state: SanguoshaState, playerId: PlayerId): number {
  return playerOf(state, playerId)?.marks[RAGE_MARK] ?? 0
}

function addRage(state: SanguoshaState, playerId: PlayerId, amount: number): void {
  const owner = playerOf(state, playerId)
  if (!owner || amount <= 0) return
  owner.marks[RAGE_MARK] = rageOf(state, playerId) + amount
}

/** 花掉暴怒。不够就不花，返回是否成功——调用方据此决定走另一条分支。 */
function spendRage(state: SanguoshaState, playerId: PlayerId, amount: number): boolean {
  if (rageOf(state, playerId) < amount) return false
  const owner = playerOf(state, playerId)!
  owner.marks[RAGE_MARK] = rageOf(state, playerId) - amount
  return true
}

/** 从神吕布座位起顺时针的其他存活角色，顺序稳定。 */
function othersFrom(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const total = state.players.length
  return state.players
    .filter((player) => player.alive && player.id !== ownerId)
    .sort((left, right) => (
      ((left.seat - owner.seat + total) % total) - ((right.seat - owner.seat + total) % total)
    ))
    .map((player) => player.id)
}

// —— 狂暴 ——

registerSkillRuntime({
  id: KUANGBAO,
  /** 游戏开始时 2 枚暴怒。 */
  onGameStart(host, ownerId) {
    addRage(host.state, ownerId, 2)
  },
  triggers: [{
    /**
     * 造成或受到伤害后各得暴怒，**按伤害点数**：造成 3 点就是 3 枚。
     *
     * 一次伤害事件既是来源又是目标的情况（自伤）在规则上不成立，
     * 但真出现也只按一边算，不重复。
     *
     * 铁索连环的传导伤害是一个个独立的伤害事件，每次都会走到这里，
     * 所以不需要为连环写特例。
     */
    event: 'Damaged',
    handle(host, ownerId, context) {
      const amount = Math.max(0, Math.trunc(Number((context.event.payload as { amount?: unknown }).amount ?? 0)))
      if (amount <= 0) return
      const isTarget = context.event.targetId === ownerId
      const isSource = context.event.sourceId === ownerId && !isTarget
      if (!isTarget && !isSource) return
      if (!playerOf(host.state, ownerId)?.alive) return
      addRage(host.state, ownerId, amount)
      host.dispatch('SkillActivated', {
        skillId: KUANGBAO, skillName: '狂暴', playerId: ownerId,
        logText: `【狂暴】${playerOf(host.state, ownerId)?.nickname}获得 ${amount} 枚「暴怒」`
          + `（共 ${rageOf(host.state, ownerId)} 枚）`,
      }, { sourceId: ownerId })
    },
  }],
})

// —— 无谋 ——

registerSkillRuntime({
  id: WUMOU,
  triggers: [{
    /**
     * 使用非延时锦囊要付代价。
     *
     * 挂在 `CardUsed` 上，所以**一张牌只触发一次**：南蛮入侵指定五个目标
     * 也只付一次代价，不是按目标数结算。
     */
    event: 'CardUsed',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardName?: string }
      const cardName = payload.cardName ?? ''
      /*
       * 按**被当作什么用的牌名**判断，不看实体牌的 category：
       * 技能把一张基本牌当【无中生有】使用时，实体牌的 category 还是 basic，
       * 但规则上使用的是锦囊，照样触发无谋。
       */
      if (!NON_DELAYED_TRICKS.has(cardName)) return
      if (!playerOf(host.state, ownerId)?.alive) return

      if (rageOf(host.state, ownerId) <= 0) {
        /*
         * 没有暴怒时**只能失去体力**，不发一个玩家付不起的二选一。
         * 失去体力走 loseHp：**不是伤害**，所以不触发狂暴、奸雄、刚烈、天香，
         * 但仍然可能进入濒死。
         */
        applyWumouHpLoss(host, ownerId)
        return
      }
      host.queueSkill({ skillId: WUMOU, ownerId, step: 'choose', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    if (!playerOf(host.state, ownerId)?.alive) return
    // 排队期间暴怒可能已经被神愤花光，这时同样只剩失去体力一条路
    if (rageOf(host.state, ownerId) <= 0) {
      applyWumouHpLoss(host, ownerId)
      return
    }
    host.askSkill({
      skillId: WUMOU, ownerId, step: 'choose',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【无谋】：移去 1 枚「暴怒」（现有 ${rageOf(host.state, ownerId)} 枚），或失去 1 点体力`,
        timeoutMs: 20_000, optional: false,
        options: [{ id: 'rage', label: '移去 1 枚暴怒' }, { id: 'hp', label: '失去 1 点体力' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId === 'rage' && spendRage(host.state, ownerId, 1)) {
      host.dispatch('SkillActivated', {
        skillId: WUMOU, skillName: '无谋', playerId: ownerId,
        logText: `【无谋】${playerOf(host.state, ownerId)?.nickname}移去 1 枚「暴怒」`
          + `（剩 ${rageOf(host.state, ownerId)} 枚）`,
      }, { sourceId: ownerId })
      return
    }
    applyWumouHpLoss(host, ownerId)
  },
})

function applyWumouHpLoss(
  host: Parameters<NonNullable<Parameters<typeof registerSkillRuntime>[0]['startQueued']>>[0],
  ownerId: PlayerId,
): void {
  host.dispatch('SkillActivated', {
    skillId: WUMOU, skillName: '无谋', playerId: ownerId,
    logText: `【无谋】${playerOf(host.state, ownerId)?.nickname}失去 1 点体力`,
  }, { sourceId: ownerId })
  loseHp(host as never, ownerId, 1, WUMOU)
}

// —— 无前 ——

registerSkillRuntime({
  id: WUQIAN,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (rageOf(state, ownerId) < WUQIAN_COST) return []
    // 经典文本没有「每阶段限一次」，只要暴怒够就能再发动
    if (othersFrom(state, ownerId).length === 0) return []
    return [{ id: WUQIAN, label: `无前（移去 ${WUQIAN_COST} 枚暴怒）` }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== WUQIAN) return
    if (rageOf(host.state, ownerId) < WUQIAN_COST) return
    const candidateIds = othersFrom(host.state, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: WUQIAN, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【无前】：选择一名其他角色，直到回合结束你拥有【无双】且其防具技能无效',
        timeoutMs: 30_000,
        // 可取消，取消不消耗暴怒
        optional: true, candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])[0]
    if (!targetId) return
    if (!playerOf(host.state, targetId)?.alive) return
    // 落地前再验一次代价：排队期间暴怒可能被别的结算花掉
    if (!spendRage(host.state, ownerId, WUQIAN_COST)) return

    /*
     * 无双是**神吕布自己本回合获得**，不是「只对这个目标有无双」。
     * 用公共的临时技能授予，同一来源重复授予是替换而不是叠加，
     * 所以一回合发动两次无前也只有一份无双，不会变成要出四张闪。
     */
    replaceTemporarySkill(host.state, ownerId, WUQIAN, 'wushuang')
    // 防具失效绑定来源：只对神吕布无效，别人打这个目标时八卦阵照常
    suppressArmor(host.state, ownerId, targetId, WUQIAN)

    host.dispatch('SkillActivated', {
      skillId: WUQIAN, skillName: '无前', playerId: ownerId, targetIds: [targetId],
      logText: `${playerOf(host.state, ownerId)?.nickname}发动【无前】，`
        + `本回合拥有【无双】，${playerOf(host.state, targetId)?.nickname}的防具技能对其无效`,
    }, { sourceId: ownerId, targetId })
  },

  triggers: [{
    /**
     * 回合结束收回无双。
     *
     * 防具失效由 `turn.ts` 的 `expireArmorSuppressions` 统一清，这里不重复清——
     * 那条纪律是「带失效时机的状态由引擎统一清理，技能不各自注册」。
     * 临时技能没有这样的统一清理入口，所以这一份留在技能里。
     */
    event: 'TurnEnd',
    handle(host, ownerId) {
      replaceTemporarySkill(host.state, ownerId, WUQIAN, null)
    },
  }],
})

// —— 神愤 ——

registerSkillRuntime({
  id: SHENFEN,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (rageOf(state, ownerId) < SHENFEN_COST) return []
    // 出牌阶段限一次，但**不是限定技**：下个出牌阶段攒够 6 枚还能再发动
    if (usedThisTurn(state, ownerId, SHENFEN)) return []
    if (othersFrom(state, ownerId).length === 0) return []
    return [{ id: SHENFEN, label: `神愤（移去 ${SHENFEN_COST} 枚暴怒）` }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== SHENFEN) return
    if (usedThisTurn(host.state, ownerId, SHENFEN)) return
    if (!spendRage(host.state, ownerId, SHENFEN_COST)) return
    markUsedThisTurn(host.state, ownerId, SHENFEN)

    host.dispatch('SkillActivated', {
      skillId: SHENFEN, skillName: '神愤', playerId: ownerId,
      logText: `${playerOf(host.state, ownerId)?.nickname}发动【神愤】`,
    }, { sourceId: ownerId })

    /*
     * 三个阶段必须**严格分开**：先对所有人造成伤害，再统一弃装备，最后统一弃手牌。
     * 不能一个人走完三步再换下一个人——经典文本的顺序就是三轮。
     *
     * 每一步都排队逐个处理：中途有人濒死要完整跑完求桃、不屈、涅槃、死亡，
     * 一口气循环下去会撞「当前濒死流程尚未结束」。
     */
    host.queueSkill({
      skillId: SHENFEN, ownerId, step: 'damage',
      data: { remaining: othersFrom(host.state, ownerId) },
    })
  },

  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    const remaining = [...((prompt.data.remaining as PlayerId[]) ?? [])]

    if (prompt.step === 'damage') {
      while (remaining.length > 0) {
        const targetId = remaining.shift()!
        if (!playerOf(host.state, targetId)?.alive) continue
        // 普通伤害，来源是神吕布；伤害本身会让狂暴正常涨暴怒
        resolveDamage(host as never, {
          sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null,
        })
        host.queueSkill({ skillId: SHENFEN, ownerId, step: 'damage', data: { remaining } })
        return
      }
      // 伤害轮走完，进入弃装备轮，名单重新取（中途可能有人死了）
      host.queueSkill({ skillId: SHENFEN, ownerId, step: 'equipment', data: { remaining: othersFrom(host.state, ownerId) } })
      return
    }

    if (prompt.step === 'equipment') {
      while (remaining.length > 0) {
        const targetId = remaining.shift()!
        const target = playerOf(host.state, targetId)
        if (!target?.alive) continue
        const equipped = Object.entries(target.zones.equipment)
          .filter((entry): entry is [string, CardId] => Boolean(entry[1]))
        if (equipped.length === 0) continue
        for (const [slot, cardId] of equipped) {
          // 走正常弃置：枭姬、白银狮子这些「失去装备」的时机才不会被跳过
          moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot: slot as never }, { kind: 'discardPile' })
          host.dispatch('LoseEquipment', { playerId: targetId, cardId, reason: SHENFEN }, { targetId, cardIds: [cardId] })
        }
        host.dispatch('LoseCard', {
          playerId: targetId, cardIds: equipped.map(([, cardId]) => cardId), reason: SHENFEN,
        }, { targetId, cardIds: equipped.map(([, cardId]) => cardId) })
        host.queueSkill({ skillId: SHENFEN, ownerId, step: 'equipment', data: { remaining } })
        return
      }
      host.queueSkill({ skillId: SHENFEN, ownerId, step: 'hand', data: { remaining: othersFrom(host.state, ownerId) } })
      return
    }

    if (prompt.step === 'hand') {
      while (remaining.length > 0) {
        const targetId = remaining.shift()!
        const target = playerOf(host.state, targetId)
        if (!target?.alive || target.zones.hand.length === 0) continue
        const count = Math.min(SHENFEN_DISCARD, target.zones.hand.length)
        host.askSkill({
          skillId: SHENFEN, ownerId: targetId, step: 'discard', data: { shenfenOwnerId: ownerId, remaining },
          build: (requestId) => ({
            id: requestId, kind: 'choose-cards' as const, playerId: targetId,
            prompt: `【神愤】：弃置 ${count} 张手牌`,
            timeoutMs: 30_000, optional: false, purpose: 'skill' as const,
            cardIds: [...target.zones.hand], hiddenCardSlots: [],
            min: count, max: count,
          }),
        })
        return
      }
      // 三轮都走完了，最后神吕布翻面
      flipCharacter(host as never, ownerId, SHENFEN)
      host.dispatch('SkillActivated', {
        skillId: SHENFEN, skillName: '神愤', playerId: ownerId,
        logText: `${owner.nickname}发动【神愤】结算完毕，将武将牌翻面`,
      }, { sourceId: ownerId })
    }
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    // ownerId 这里是被弃牌的角色（askSkill 时传的是他）
    const shenfenOwnerId = resolution.data.shenfenOwnerId as PlayerId
    const remaining = (resolution.data.remaining as PlayerId[]) ?? []
    const cardIds = ((response.payload as { cardIds?: CardId[] }).cardIds ?? [])
    const target = playerOf(host.state, ownerId)
    if (target?.alive) {
      const valid = cardIds.filter((cardId) => target.zones.hand.includes(cardId))
      for (const cardId of valid) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      }
      if (valid.length > 0) {
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: SHENFEN }, { targetId: ownerId, cardIds: valid })
      }
    }
    host.queueSkill({ skillId: SHENFEN, ownerId: shenfenOwnerId, step: 'hand', data: { remaining } })
  },
})

export const SHENLVBU: CharacterDefinition = {
  id: 'shenlvbu',
  name: '神·吕布',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 5,
  pack: 'god',
  skills: [
    {
      id: KUANGBAO,
      name: '狂暴',
      description: '锁定技，游戏开始时，你获得2枚「暴怒」；每当你造成或受到1点伤害后，你获得1枚「暴怒」。',
    },
    {
      id: WUMOU,
      name: '无谋',
      description: '锁定技，每当你使用一张非延时锦囊牌时，你须移去1枚「暴怒」或失去1点体力。',
    },
    {
      id: WUQIAN,
      name: '无前',
      description: '出牌阶段，你可以移去2枚「暴怒」并选择一名其他角色：直到回合结束，你拥有【无双】，且该角色的防具技能无效。',
    },
    {
      id: SHENFEN,
      name: '神愤',
      description: '出牌阶段限一次，你可以移去6枚「暴怒」：对所有其他角色各造成1点伤害；然后所有其他角色弃置装备区所有牌；然后所有其他角色各弃置四张手牌；然后你将武将牌翻面。',
    },
  ],
}
