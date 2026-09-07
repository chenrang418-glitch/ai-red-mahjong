import { flipCharacter } from '../../engine/character-state'
import { continueDyingRescue } from '../../engine/damage'
import { effectiveKingdomOf } from '../../engine/huashen'
import type { ChooseOptionRequest, GameResponse } from '../../engine/requests'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

export const DANGXIAN = 'dangxian'
export const FULI = 'fuli'
const FULI_INVOKE = 'fuli-invoke'

function ownerOf(state: SanguoshaState, ownerId: PlayerId) {
  return state.players.find((player) => player.id === ownerId)
}

/**
 * 【伏枥】回复到的目标体力 X = **当前存活角色的不同势力数**。
 *
 * 三点口径：
 * - 去重。三个蜀国角色只算一个势力。
 * - 只数**存活**角色，已阵亡的不算——技能文本说的是「现存势力」。
 * - 走 `effectiveKingdomOf`，所以化身（神吕蒙【化身】）当下顶的那个势力算数，
 *   而不是他武将牌上印的势力。
 *
 * 发动伏枥的人自己也活着，所以 X 至少是 1，回复之后必定脱离濒死。
 */
export function livingKingdomCount(state: SanguoshaState): number {
  const kingdoms = new Set<string>()
  for (const player of state.players) {
    if (!player.alive) continue
    const kingdom = effectiveKingdomOf(state, player.id)
    if (kingdom) kingdoms.add(kingdom)
  }
  return kingdoms.size
}

/**
 * 廖化【当先】：锁定技，回合开始时执行一个额外的出牌阶段。
 *
 * 只声明「要一个额外的出牌阶段」，插到哪里、怎么收束由 `extra-phase.ts`
 * 那套公共调度决定——引擎里没有一行认得 `liaohua` 这个 id。
 *
 * 额外阶段是**阶段不是回合**，所以：回合级的「本回合限一次」两个出牌阶段
 * 共用，而「出牌阶段限一次」在两个阶段里各有一次；【杀】的使用次数按
 * 出牌阶段实例算，于是他一个回合能出两张【杀】（「二刀」）。
 */
registerSkillRuntime({
  id: DANGXIAN,
  extraPhaseAtTurnStart(state, ownerId) {
    const owner = ownerOf(state, ownerId)
    if (!owner?.alive) return null
    return 'play'
  },
  triggers: [{
    /*
     * 只为了记一笔战报和压测计数，不做任何规则动作。
     *
     * 挂在 `PhaseStart` 上而不是在调度里 dispatch：调度发生在 `beginTurn`
     * 里，那是一段同步代码，往里塞事件派发会把技能结算拖进回合流转中间。
     */
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const extra = host.state.extraPhase
      if (!extra || extra.skillId !== DANGXIAN || extra.playerId !== ownerId) return
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== extra.phase) return
      const owner = ownerOf(host.state, ownerId)
      if (!owner) return
      host.dispatch('SkillActivated', {
        skillId: DANGXIAN, skillName: '当先', playerId: ownerId,
        logText: `${owner.nickname}的锁定技【当先】发动，执行一个额外的出牌阶段`,
      }, { sourceId: ownerId })
    },
  }],
})

/**
 * 廖化【伏枥】：限定技，濒死时可以将体力回复至 X 点，然后将武将牌翻面。
 *
 * 走的是和庞统【涅槃】同一个 `dyingIntercept` 窗口：在 `EnterDying` 之后、
 * 第一次求桃之前问一次，玩家不发动就照常求桃。
 *
 * 「回复**至** X 点」不是「回复 X 点」：体力 -2、X 为 3 时要回 5 点；
 * 同时不超过体力上限。X 已经不小于当前体力时不回复——但那时他仍然在濒死，
 * 所以这一条实际上到不了（X ≥ 1 > 濒死时的体力）。
 */
registerSkillRuntime({
  id: FULI,
  limited: true,
  dyingIntercept(host, ownerId) {
    const owner = ownerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(FULI)) return false
    const target = livingKingdomCount(host.state)
    host.askSkill({
      skillId: FULI,
      ownerId,
      step: 'dying',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId,
        kind: 'choose-option',
        playerId: ownerId,
        prompt: '你处于濒死状态，是否发动限定技【伏枥】？',
        timeoutMs: 20_000,
        optional: true,
        options: [
          { id: FULI_INVOKE, label: `发动【伏枥】：将体力回复至${target}点，然后将武将牌翻面` },
          { id: 'cancel', label: '不发动，继续求桃' },
        ],
      }),
    })
    return 'pending'
  },
  resume(host, ownerId, resolution, response: GameResponse) {
    if (resolution.step !== 'dying' || host.state.dying?.playerId !== ownerId) return
    const owner = ownerOf(host.state, ownerId)
    if (!owner?.alive) return

    const declined = (response.payload as { optionId?: string }).optionId !== FULI_INVOKE
    // 限定技已经用过：窗口开出去之后被别的效果用掉是不可能的，但读的是同一份
    // `usedLimitedSkills`，这里再确认一次，免得靠「窗口开过就一定还能用」的假设
    if (declined || owner.usedLimitedSkills.includes(FULI)) {
      continueDyingRescue(host)
      if (!host.state.dying) host.resumeAfterDying()
      return
    }

    owner.usedLimitedSkills.push(FULI)
    /*
     * 势力数在**发动的这一刻**重新数一遍，不用开窗口时算的那个值。
     * 窗口挂起期间可能有人阵亡（连锁伤害、濒死链上别人先死），
     * 那时「现存势力」已经变了。
     */
    const target = Math.min(owner.maxHp, livingKingdomCount(host.state))
    const recovered = Math.max(0, target - owner.hp)
    if (recovered > 0) {
      owner.hp = target
      host.dispatch('Recover', { playerId: ownerId, amount: recovered, reason: FULI }, { targetId: ownerId })
    }
    host.dispatch('SkillActivated', {
      skillId: FULI, skillName: '伏枥', playerId: ownerId,
      logText: `${owner.nickname}发动限定技【伏枥】，将体力回复至${owner.hp}点并将武将牌翻面`,
    }, { sourceId: ownerId })
    // 翻面是**切换**：正面翻到背面，本来背面朝上就翻回正面
    flipCharacter(host, ownerId, FULI, !owner.faceDown)
    host.dispatch('QuitDying', { playerId: ownerId, hp: owner.hp, reason: FULI }, { targetId: ownerId })
    host.state.dying = null
    host.resumeAfterDying()
  },
})

export const LIAOHUA: CharacterDefinition = {
  id: 'liaohua',
  name: '廖化',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2012',
  skills: [
    { id: DANGXIAN, name: '当先', description: '锁定技，回合开始时，你执行一个额外的出牌阶段。' },
    { id: FULI, name: '伏枥', description: '限定技，当你处于濒死状态时，你可以将体力回复至X点（X为当前存活角色的势力数），然后将你的武将牌翻面。' },
  ],
}
