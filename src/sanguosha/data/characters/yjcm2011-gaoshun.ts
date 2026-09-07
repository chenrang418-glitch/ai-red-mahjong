import { suppressArmor } from '../../engine/armor-suppression'
import { canPindian, registerPindianContinuation, startPindian } from '../../engine/pindian'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { prohibitSlashThisTurn } from '../../engine/slash-rules'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 高顺（一将成名 2011 经典）。
 *
 * 【陷阵】：出牌阶段限一次，你可以与一名角色拼点。若你赢，直到回合结束，
 *          你对其使用牌无距离限制、无视其防具，且对其使用【杀】无次数限制；
 *          若你没赢，直到回合结束，你不能使用【杀】。
 * 【禁酒】：锁定技，你的【酒】均视为【杀】。
 *
 * 六处最容易做错的：
 *
 * 1. **平局算「没赢」**，走失败分支。
 * 2. **胜利后的三项都是定向的**：只对拼点的那个目标成立。别人打他照样有防具，
 *    他打别人照样受距离和次数限制。
 * 3. **无视防具是压制防具技能，不是卸装备**：牌仍然装在目标身上，
 *    对其他人照常生效。**武将技能不是防具技能**——于禁【毅重】不受影响。
 * 4. **多目标的一张【杀】只有在每个目标都是陷阵目标时才免次数**，
 *    捎带一个普通目标就得按普通次数算（公共规则在 `slash-rules.ts` 里）。
 * 5. **失败禁的是「使用」**：需要时仍然可以打出【杀】响应，
 *    但任何转化出来的【杀】（武圣、龙胆、禁酒的酒）都不能使用。
 * 6. **禁酒是强制改写身份**，不是「可以当杀用」：那张【酒】不能再当酒喝，
 *    濒死时也救不了自己；花色点数继承原牌。
 */

const XIANZHEN = 'xianzhen'
const JINJIU = 'jinjiu'
const XIANZHEN_ACTION = 'xianzhen-invoke'
const XIANZHEN_TAG = 'xianzhen'

/** 陷阵胜利对谁生效。存的是「第几个回合」，回合一换自然过期。 */
function wonMark(targetId: PlayerId): string {
  return `xianzhen-won:${targetId}`
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 高顺这一回合有没有陷阵赢过这个目标。 */
function xianzhenWon(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return false
  return owner.marks[wonMark(targetId)] === state.turnNumber
}

/** 能和谁拼点：双方都得有手牌。 */
function xianzhenTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  if (!canPindian(state, ownerId)) return []
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId && canPindian(state, candidate.id))
    .map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: XIANZHEN,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    // **按阶段限一次**：一个回合里出现第二个出牌阶段时可以再来一次
    if (usedThisPhase(state, ownerId, XIANZHEN)) return []
    if (xianzhenTargets(state, ownerId).length === 0) return []
    return [{ id: XIANZHEN_ACTION, label: '陷阵：与一名角色拼点' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== XIANZHEN_ACTION) return
    const candidateIds = xianzhenTargets(host.state, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: XIANZHEN, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【陷阵】：选择一名角色与其拼点',
        timeoutMs: 25_000,
        /*
         * **必答**：点技能这一下就是发动，选人不是一个可以反悔的窗口。
         *
         * 留成可取消的话，「发动 → 取消 → 没计次 → 动作又回到列表里」
         * 是一个纯粹的空转，压测里当场变成死循环（seed=yjcm11b3-5-1）。
         * 入口本身已经保证了「一定有合法的拼点对象」，所以永远选得出人。
         */
        optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId || !xianzhenTargets(host.state, ownerId).includes(targetId)) return
    markUsedThisPhase(host.state, ownerId, XIANZHEN)
    startPindian(host, {
      id: `xianzhen-${host.state.seq}`,
      initiatorId: ownerId,
      opponentId: targetId,
      reason: XIANZHEN,
      continuationTag: XIANZHEN_TAG,
    })
  },

  /*
   * 胜利后的两项定向豁免。都问「对这个目标」，不是「对所有人」。
   * 第三项（无视防具）走公共的来源—目标防具压制，在拼点结算里施加。
   */
  ignoresDistanceTo(state, ownerId, targetId) {
    return xianzhenWon(state, ownerId, targetId)
  },
  ignoresSlashUsesTo(state, ownerId, targetId) {
    return xianzhenWon(state, ownerId, targetId)
  },
})

registerPindianContinuation(XIANZHEN_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  const ownerId = result.initiatorId
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const targetId = result.opponentId
  const target = playerOf(host.state, targetId)

  // 平局是独立的一种结果，**不能塞进「谁赢」里**——它走的是失败分支
  if (result.outcome === 'initiator-win') {
    /*
     * 赢了：三项都只对这一对角色成立，而且都绑在**这一个回合**上。
     * 记的是回合序号，回合一换自然过期——不需要另外注册清理。
     */
    owner.marks[wonMark(targetId)] = host.state.turnNumber
    // 无视防具走公共的来源—目标压制：牌仍然装在他身上，对别人照常生效
    suppressArmor(host.state, ownerId, targetId, XIANZHEN)
    skillHost.dispatch('SkillActivated', {
      skillId: XIANZHEN, skillName: '陷阵', playerId: ownerId, targetId,
      logText: `${owner.nickname}拼点赢了，本回合对${target?.nickname ?? ''}无距离限制、无视其防具，且出【杀】无次数限制`,
    }, { sourceId: ownerId, targetId })
    return
  }

  /*
   * 没赢（**平局也算没赢**）：本回合不能使用【杀】。
   * 走公共的本回合杀规则，回合结束由 `turn.ts` 统一清理；
   * 禁的是「使用」，需要时仍然可以打出【杀】响应。
   */
  prohibitSlashThisTurn(host.state, ownerId)
  skillHost.dispatch('SkillActivated', {
    skillId: XIANZHEN, skillName: '陷阵', playerId: ownerId, targetId,
    logText: `${owner.nickname}没有拼点赢，本回合不能使用【杀】`,
  }, { sourceId: ownerId, targetId })
})

// ─────────────────────────────── 禁酒 ───────────────────────────────

registerSkillRuntime({
  id: JINJIU,
  forcedCardIdentity(state, _ownerId, cardId) {
    /*
     * **锁定技，常驻**：他手上的【酒】就是【杀】。
     *
     * 走统一的「强制身份改写」，于是三件事一次到位：
     * 出牌阶段只出得了【杀】的动作、响应路径按【杀】过滤、
     * 濒死时那张牌救不了自己。花色和点数仍然是原牌的，
     * 所以【毅重】按黑色【杀】判、【异兆】按原点数记。
     */
    const card = state.cards[cardId as CardId]
    if (card?.name !== '酒') return null
    return { asCardName: '杀', nature: 'normal' }
  },
})

export const GAOSHUN: CharacterDefinition = {
  id: 'gaoshun',
  name: '高顺',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2011',
  skills: [
    {
      id: XIANZHEN,
      name: '陷阵',
      description: '出牌阶段限一次，你可以与一名角色拼点。若你赢，直到回合结束，'
        + '你对其使用牌无距离限制、无视其防具，且对其使用【杀】无次数限制；'
        + '若你没赢，直到回合结束，你不能使用【杀】。',
    },
    {
      id: JINJIU,
      name: '禁酒',
      description: '锁定技，你的【酒】均视为【杀】。',
    },
  ],
}
