import { executeUseCardAction } from '../../engine/cards/basic'
import { instantTrickActions } from '../../engine/cards/tricks'
import { addForcedAwakening, pendingAwakeningSkills } from '../../engine/forced-awakening'
import { gainMaxHp, loseMaxHp } from '../../engine/hp'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import {
  beginJudgmentRetention,
  endJudgmentRetention,
  retainedJudgmentCards,
  retainedJudgmentSuits,
} from '../../engine/judgment-retention'
import { recover } from '../../engine/recover'
import { recordSkillGrantSource, skillGrantSourceOf } from '../../engine/skill-grant-source'
import { grantSkill, registerSkillRuntime, skillsOf } from '../../engine/skills/runtime'
import { getCharacter } from './standard'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { createVirtualTrick, virtualTrickChoices } from '../../engine/virtual-trick'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神郭嘉。
 *
 * 【慧识】：出牌阶段限一次，体力上限小于 10 时可以连续判定，每次花色都和之前不同
 *   就能继续并加 1 点体力上限；结束后把所有生效的判定牌一次性交给一名角色，
 *   若其手牌数为全场最多则自己减 1 点体力上限。
 * 【天翊】：觉醒技，准备阶段，所有存活角色本局都受到过伤害时，加 2 点体力上限、
 *   回复 1 点体力，并令一名角色获得【佐幸】。
 * 【辉逝】：限定技，出牌阶段选一名角色：满足条件就令其一个未触发的觉醒技视为
 *   已满足觉醒条件，否则其摸四张牌；无论走哪一支，自己减 2 点体力上限。
 * 【佐幸】：出牌阶段限一次，令来源的神郭嘉减 1 点体力上限，然后视为使用一张普通锦囊牌。
 *
 * 四个技能全部建立在公共机制上，引擎里没有一处按 characterId 的特判：
 * 判定牌暂存、强制觉醒条件、授技来源绑定、虚拟普通锦囊选择器。
 */

const HUISHI = 'huishi'
/**
 * 辉逝的 id 不写成 `huishi`。
 *
 * 「慧识」和「辉逝」的拼音转写撞在一起（huishi），两个技能共用一个 id 会让
 * 技能注册表、已用记账和限定技记录全部串味。这里用一个不会歧义的写法。
 */
const HUISHIFADE = 'huishifade'
/**
 * 天翊的 id 不写成 `tianyi`：火包太史慈的【天义】已经占了这个转写。
 * 同音撞车会让技能注册表直接抛「技能重复注册」，也会让两个技能的记账串味。
 */
const TIANYI = 'tianyiwing'
const ZUOXING = 'zuoxing'

/** 慧识的体力上限硬顶。技能自身不能把上限顶过这个数。 */
const HUISHI_MAX_HP_CAP = 10
/** 判定续接的 tag。暂存按它认领，别的技能插进来的判定不会被收走。 */
const HUISHI_JUDGE_TAG = 'huishi-judge'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function aliveIds(state: SanguoshaState): PlayerId[] {
  return state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
}

/** 某个武将牌上印着的技能条目。 */
function characterSkillsOf(characterId: string): string[] {
  return (getCharacter(characterId)?.skills ?? []).map((skill) => skill.id)
}

/**
 * 这个人身上所有觉醒技的 id。
 *
 * **必须把武将自带技能算进来**：觉醒技基本都是印在武将牌上的，
 * 只数被授予的技能会一个都找不到（写成 `() => []` 时踩过）。
 */
function awakeningSkillIdsOf(state: SanguoshaState, playerId: PlayerId): string[] {
  return skillsOf(state, playerId, characterSkillsOf)
    .filter((runtime) => !!runtime.awakening)
    .map((runtime) => runtime.id)
}

function skillLabel(skillId: string): string {
  const NAMES: Record<string, string> = {
    baiyin: '拜印', zhaoxian: '凿险', zhiji: '志继', hunzi: '魂姿', tianyiwing: '天翊',
  }
  return NAMES[skillId] ?? skillId
}

// ─────────────────────────────── 慧识 ───────────────────────────────

/**
 * 这次判定之后还能不能继续。
 *
 * 两个条件都要成立：本次花色和**之前每一次**都不同，且此刻体力上限仍小于 10。
 * 花色读的是暂存里记下的**最终**花色——判定可能被改判或【铁骑】改过，
 * 事后从牌面反推会读到印刷值。
 */
function huishiCanContinue(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive || owner.maxHp >= HUISHI_MAX_HP_CAP) return false
  const suits = retainedJudgmentSuits(state)
  if (suits.length === 0) return false
  const latest = suits[suits.length - 1]
  return !suits.slice(0, -1).includes(latest)
}

/** 结束慧识：把暂存的判定牌交给某人（或没人要就进弃牌堆），再算惩罚。 */
function finishHuishi(host: SkillHostLike, ownerId: PlayerId, recipientId: PlayerId | null): void {
  const state = host.state
  const cardIds = endJudgmentRetention(state, recipientId)
  const owner = playerOf(state, ownerId)
  if (!owner?.alive || cardIds.length === 0 || !recipientId) return

  const recipient = playerOf(state, recipientId)
  if (!recipient?.alive) return
  host.dispatch('GainCard', { playerId: recipientId, cardIds, reason: HUISHI }, { targetId: recipientId, cardIds })
  host.dispatch('SkillActivated', {
    skillId: HUISHI, skillName: '慧识', playerId: ownerId,
    logText: `${owner.nickname}发动【慧识】，将 ${cardIds.length} 张判定牌交给${recipient.nickname}`,
  }, { sourceId: ownerId, targetId: recipientId, cardIds })

  /*
   * 「全场最多」按**并列也算**处理：文本说的是「为全场最多」，
   * 和别人一样多同样满足这个描述。
   */
  const most = Math.max(...state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.zones.hand.length))
  if (recipient.zones.hand.length >= most) loseMaxHp(host as never, ownerId, 1, HUISHI)
}

/** 最小可用的宿主形状：这个文件只用到这几样。 */
interface SkillHostLike {
  state: SanguoshaState
  dispatch(name: string, payload?: Record<string, unknown>, metadata?: Record<string, unknown>): unknown
  askSkill(options: { skillId: string; ownerId: PlayerId; step: string; data?: Record<string, unknown>; build(requestId: string): unknown }): void
}

registerJudgmentContinuation(HUISHI_JUDGE_TAG, (host, _judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const owner = playerOf(host.state, ownerId)
  // 判定期间人没了：暂存不能留在处理区，按普通判定牌归弃牌堆
  if (!owner?.alive) {
    endJudgmentRetention(host.state, null)
    return
  }
  if (huishiCanContinue(host.state, ownerId)) {
    askHuishiContinue(host as unknown as SkillHostLike, ownerId)
    return
  }
  askHuishiRecipient(host as unknown as SkillHostLike, ownerId)
})

function askHuishiContinue(host: SkillHostLike, ownerId: PlayerId): void {
  const count = retainedJudgmentCards(host.state).length
  host.askSkill({
    skillId: HUISHI,
    ownerId,
    step: 'continue',
    build: (requestId) => ({
      id: requestId, kind: 'choose-option', playerId: ownerId,
      prompt: `【慧识】：已判定 ${count} 次，是否继续（继续将增加 1 点体力上限）`,
      timeoutMs: 20_000, optional: false, purpose: 'skill',
      options: [{ id: 'yes', label: '继续判定' }, { id: 'no', label: '停止' }],
    }),
  })
}

function askHuishiRecipient(host: SkillHostLike, ownerId: PlayerId): void {
  const cards = retainedJudgmentCards(host.state)
  if (cards.length === 0) {
    endJudgmentRetention(host.state, null)
    return
  }
  host.askSkill({
    skillId: HUISHI,
    ownerId,
    step: 'give',
    build: (requestId) => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId,
      prompt: `【慧识】：可将 ${cards.length} 张生效的判定牌交给一名角色`,
      timeoutMs: 25_000, optional: true, purpose: 'skill',
      // 文本是「任意一名角色」，包含自己
      candidateIds: aliveIds(host.state), min: 0, max: 1,
    }),
  })
}

registerSkillRuntime({
  id: HUISHI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.maxHp >= HUISHI_MAX_HP_CAP) return []
    if (usedThisTurn(state, ownerId, HUISHI)) return []
    return [{ id: HUISHI, label: '发动【慧识】' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== HUISHI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.maxHp >= HUISHI_MAX_HP_CAP) return
    if (usedThisTurn(host.state, ownerId, HUISHI)) return
    markUsedThisTurn(host.state, ownerId, HUISHI)
    host.dispatch('SkillActivated', {
      skillId: HUISHI, skillName: '慧识', playerId: ownerId,
      logText: `${owner.nickname}发动【慧识】`,
    }, { sourceId: ownerId })
    beginJudgmentRetention(host.state, ownerId, HUISHI_JUDGE_TAG)
    performJudgment(host as never, ownerId, '慧识', { tag: HUISHI_JUDGE_TAG, data: { ownerId } })
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; targetIds?: PlayerId[] }

    if (resolution.step === 'continue') {
      if (payload.optionId !== 'yes') {
        askHuishiRecipient(host as unknown as SkillHostLike, ownerId)
        return
      }
      // 落地前再确认一次：挂起期间体力上限可能已经变了
      if (!huishiCanContinue(host.state, ownerId)) {
        askHuishiRecipient(host as unknown as SkillHostLike, ownerId)
        return
      }
      /*
       * 「重复此判定」和「增加 1 点体力上限」是同一个动作的两半，
       * 不是先加上限再判定，也不是判完再加。
       */
      gainMaxHp(host as never, ownerId, 1, HUISHI, HUISHI_MAX_HP_CAP)
      performJudgment(host as never, ownerId, '慧识', { tag: HUISHI_JUDGE_TAG, data: { ownerId } })
      return
    }

    if (resolution.step === 'give') {
      const targetId = payload.targetIds?.[0] ?? null
      finishHuishi(host as unknown as SkillHostLike, ownerId, targetId)
    }
  },
})

// ─────────────────────────────── 天翊 ───────────────────────────────

registerSkillRuntime({
  id: TIANYI,
  awakening: {
    phase: 'prepare',
    /*
     * 「所有存活的角色本局均受到过伤害」。
     *
     * 只看**存活**角色：从没受过伤但已经死了的人不挡觉醒。
     * 受伤记账走公共状态位，失去体力（崩坏、无谋）和被防止的伤害都不算。
     */
    ready(state) {
      const alive = state.players.filter((candidate) => candidate.alive)
      return alive.length > 0 && alive.every((candidate) => candidate.hasTakenDamage === true)
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      // 严格按文本顺序：先加上限，再回复，最后授技
      gainMaxHp(host as never, ownerId, 2, TIANYI)
      recover(host as never, ownerId, 1, ownerId)
      host.dispatch('SkillActivated', {
        skillId: TIANYI, skillName: '天翊', playerId: ownerId,
        logText: `${owner.nickname}觉醒【天翊】，增加 2 点体力上限并回复 1 点体力`,
      }, { sourceId: ownerId })
      host.askSkill({
        skillId: TIANYI,
        ownerId,
        step: 'grant',
        build: (requestId) => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【天翊】：令一名角色获得【佐幸】',
          timeoutMs: 25_000, optional: false, purpose: 'skill',
          // 文本是「一名角色」，自己也可以
          candidateIds: aliveIds(host.state), min: 1, max: 1,
        }),
      })
    },
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'grant') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    grantSkill(host.state, target.id, ZUOXING)
    /*
     * 记下是**哪个**神郭嘉授的。
     *
     * 佐幸要花来源的体力上限；娱乐模式允许同名武将重复出现，
     * 只按「场上还有没有神郭嘉活着」判断的话，A 授出的佐幸能去花 B 的上限。
     */
    recordSkillGrantSource(host.state, { playerId: target.id, skillId: ZUOXING, sourceId: ownerId })
    host.dispatch('SkillActivated', {
      skillId: TIANYI, skillName: '天翊', playerId: ownerId,
      logText: `${playerOf(host.state, ownerId)?.nickname}令${target.nickname}获得【佐幸】`,
    }, { sourceId: ownerId, targetId: target.id })
  },
})

// ─────────────────────────────── 辉逝 ───────────────────────────────

registerSkillRuntime({
  id: HUISHIFADE,
  limited: true,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    // 限定技：一局一次，永不重置。`limited: true` 只是元数据，记账要自己查
    if (owner.usedLimitedSkills.includes(HUISHIFADE)) return []
    return [{ id: HUISHIFADE, label: '发动【辉逝】' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== HUISHIFADE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(HUISHIFADE)) return
    /*
     * 一进来就记账，不等结算完。
     * 中途要挂起两次（选目标、选觉醒技），不先记的话这期间入口还亮着，
     * 玩家能把限定技点第二次。
     */
    owner.usedLimitedSkills.push(HUISHIFADE)
    host.askSkill({
      skillId: HUISHIFADE,
      ownerId,
      step: 'target',
      build: (requestId) => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【辉逝】：选择一名角色',
        timeoutMs: 25_000, optional: false, purpose: 'skill',
        candidateIds: aliveIds(host.state), min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const pending = pendingAwakeningSkills(host.state, target.id, awakeningSkillIdsOf)
      const aliveCount = aliveIds(host.state).length
      // 有未触发的觉醒技，而且自己的体力上限撑得住场上人数，才走强制觉醒那一支
      if (pending.length > 0 && owner.maxHp >= aliveCount) {
        host.askSkill({
          skillId: HUISHIFADE,
          ownerId,
          step: 'skill',
          data: { targetId: target.id },
          build: (requestId) => ({
            id: requestId, kind: 'choose-option', playerId: ownerId,
            prompt: `【辉逝】：令${target.nickname}的哪个觉醒技视为已满足条件`,
            timeoutMs: 25_000, optional: false, purpose: 'skill',
            options: pending.map((skillId) => ({ id: skillId, label: `【${skillLabel(skillId)}】` })),
          }),
        })
        return
      }
      drawFour(host as unknown as SkillHostLike, ownerId, target.id)
      loseMaxHp(host as never, ownerId, 2, HUISHIFADE)
      return
    }

    if (resolution.step === 'skill') {
      const targetId = resolution.data.targetId as PlayerId
      const skillId = (response.payload as { optionId?: string }).optionId
      const target = playerOf(host.state, targetId)
      if (!target?.alive || !skillId) return
      // 挂起期间对方可能已经把这个技能觉醒掉了
      if (!pendingAwakeningSkills(host.state, targetId, awakeningSkillIdsOf).includes(skillId)) return
      /*
       * **不是立刻把觉醒效果执行一遍。**
       * 只把条件那一关放行；时机、记账和效果仍走觉醒技自己的那一套。
       */
      addForcedAwakening(host.state, { playerId: targetId, skillId, sourceId: ownerId })
      host.dispatch('SkillActivated', {
        skillId: HUISHIFADE, skillName: '辉逝', playerId: ownerId,
        logText: `${playerOf(host.state, ownerId)?.nickname}发动【辉逝】，令${target.nickname}的【${skillLabel(skillId)}】视为已满足觉醒条件`,
      }, { sourceId: ownerId, targetId })
      loseMaxHp(host as never, ownerId, 2, HUISHIFADE)
    }
  },
})

function drawFour(host: SkillHostLike, ownerId: PlayerId, targetId: PlayerId): void {
  const state = host.state
  const target = playerOf(state, targetId)
  if (!target?.alive) return
  const drawn: CardId[] = []
  for (let index = 0; index < 4; index += 1) {
    const cardId = state.zones.drawPile.shift()
    if (!cardId) break
    target.zones.hand.push(cardId)
    drawn.push(cardId)
  }
  if (drawn.length === 0) return
  host.dispatch('GainCard', { playerId: targetId, cardIds: drawn, reason: HUISHIFADE }, { targetId, cardIds: drawn })
  host.dispatch('SkillActivated', {
    skillId: HUISHIFADE, skillName: '辉逝', playerId: ownerId,
    logText: `${playerOf(state, ownerId)?.nickname}发动【辉逝】，令${target.nickname}摸四张牌`,
  }, { sourceId: ownerId, targetId })
}

// ─────────────────────────────── 佐幸 ───────────────────────────────

/** 佐幸现在能不能发动：来源的神郭嘉还活着，而且体力上限大于 1。 */
function zuoxingSourceReady(state: SanguoshaState, ownerId: PlayerId): PlayerId | null {
  const sourceId = skillGrantSourceOf(state, ownerId, ZUOXING)
  if (!sourceId) return null
  const source = playerOf(state, sourceId)
  if (!source?.alive || source.maxHp <= 1) return null
  return sourceId
}

registerSkillRuntime({
  id: ZUOXING,
  activeActions(state, ownerId) {
    if (usedThisTurn(state, ownerId, ZUOXING)) return []
    if (!zuoxingSourceReady(state, ownerId)) return []
    if (virtualTrickChoices(state, ownerId).length === 0) return []
    return [{ id: ZUOXING, label: '发动【佐幸】' }]
  },
  activeActionUsesCard: true,
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZUOXING) return
    if (usedThisTurn(host.state, ownerId, ZUOXING)) return
    if (!zuoxingSourceReady(host.state, ownerId)) return
    const choices = virtualTrickChoices(host.state, ownerId)
    if (choices.length === 0) return
    host.askSkill({
      skillId: ZUOXING,
      ownerId,
      step: 'trick',
      build: (requestId) => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【佐幸】：视为使用一张普通锦囊牌',
        timeoutMs: 25_000, optional: false, purpose: 'skill',
        options: choices.map((name) => ({ id: name, label: `【${name}】` })),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state

    if (resolution.step === 'trick') {
      const name = (response.payload as { optionId?: string }).optionId
      if (!name || !virtualTrickChoices(state, ownerId).includes(name)) return
      const sourceId = zuoxingSourceReady(state, ownerId)
      if (!sourceId) return
      if (usedThisTurn(state, ownerId, ZUOXING)) return
      markUsedThisTurn(state, ownerId, ZUOXING)

      const cardId = createVirtualTrick(state, ownerId, name, ZUOXING)
      const [action] = instantTrickActions(state, ownerId, cardId, name)
      if (!action || action.kind !== 'use-card') {
        // 落地时已经没有合法目标：把印出来的牌撤掉，不留残牌
        discardVirtual(state, ownerId, cardId)
        return
      }

      // 代价先付：文本是「令神郭嘉减 1 点体力上限，然后视为使用」
      loseMaxHp(host as never, sourceId, 1, ZUOXING)
      host.dispatch('SkillActivated', {
        skillId: ZUOXING, skillName: '佐幸', playerId: ownerId,
        logText: `${playerOf(state, ownerId)?.nickname}发动【佐幸】，视为使用【${name}】`,
      }, { sourceId: ownerId })

      // 固定目标的锦囊（南蛮、万箭、桃园、五谷）直接走，不必再问
      if (action.targetMode === 'fixed' || action.targetMax === 0) {
        executeUseCardAction(host as never, ownerId, action)
        return
      }
      host.askSkill({
        skillId: ZUOXING,
        ownerId,
        step: 'targets',
        data: { cardId, cardName: name },
        build: (requestId) => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【佐幸】：为【${name}】选择目标`,
          timeoutMs: 25_000, optional: false, purpose: 'skill',
          candidateIds: action.targetIds, min: action.targetMin, max: action.targetMax,
        }),
      })
      return
    }

    if (resolution.step === 'targets') {
      const cardId = resolution.data.cardId as CardId
      const name = resolution.data.cardName as string
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const [action] = instantTrickActions(state, ownerId, cardId, name)
      if (!action || action.kind !== 'use-card' || targetIds.length === 0) {
        discardVirtual(state, ownerId, cardId)
        return
      }
      executeUseCardAction(host as never, ownerId, { ...action, targetIds })
    }
  },
})

/** 印出来但没用出去的虚拟牌要就地销毁，不能留在手上，也不能进弃牌堆。 */
function discardVirtual(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): void {
  const owner = playerOf(state, ownerId)
  if (owner) owner.zones.hand = owner.zones.hand.filter((candidate) => candidate !== cardId)
  delete state.cards[cardId]
}

export const SHENGUOJIA: CharacterDefinition = {
  id: 'shenguojia',
  name: '神·郭嘉',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 3,
  pack: 'god',
  skills: [
    {
      id: HUISHI,
      name: '慧识',
      description: '出牌阶段限一次，若你体力上限小于10，你可进行一次判定：若判定结果与本阶段内以此法进行判定的判定结果花色均不相同，且此时你体力上限小于10，你可以重复此判定并增加1点体力上限。然后你可以将所有生效的判定牌交给任意一名角色。然后若其手牌数为全场最多，你减少1点体力上限。',
    },
    {
      id: TIANYI,
      name: '天翊',
      description: '觉醒技，准备阶段，若所有存活的角色在本局游戏内均受到过伤害，你增加2点体力上限，回复1点体力，然后令一名角色获得技能【佐幸】。',
    },
    {
      id: HUISHIFADE,
      name: '辉逝',
      description: '限定技，出牌阶段，你可选择一名角色：若其有未触发的觉醒技，且你体力上限不小于X（X为场上存活人数），则你选择其中一个觉醒技，其视为已满足觉醒条件；否则其摸四张牌。若如此做，你减少2点体力上限。',
    },
    {
      id: ZUOXING,
      name: '佐幸',
      description: '出牌阶段限一次，若神郭嘉存活且体力上限大于1，你可令神郭嘉减1点体力上限，然后你视为使用一张普通锦囊牌。',
      granted: true,
    },
  ],
}
