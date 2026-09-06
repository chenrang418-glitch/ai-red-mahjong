import { drawCards } from '../../engine/draw'
import { handStateFingerprint, lostHpOf } from '../../engine/hand-state-trigger'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张春华（一将成名 2011 经典）。
 *
 * 【绝情】：锁定技，你造成的伤害均改为等量的失去体力。
 * 【伤逝】：若你的手牌数小于你已损失的体力值，你可以将手牌补至等同于已损失的体力值。
 *
 * 四处最容易做错的：
 *
 * 1. **绝情是「换掉」，不是「先打再补」也不是「防止之后另外扣血」。**
 *    那两种做法都会真的触发一次伤害时机，卖血技能会照常起效——
 *    而绝情最大的价值恰恰是让对面的卖血技能落空。
 * 2. **因绝情而死没有击杀者**：失去体力不是伤害，没有伤害来源可言，
 *    所以不触发身份局的击杀奖惩。
 * 3. **已损失体力值要现算**：`maxHp - hp`，不能写死成「3 - hp」——上限是会变的。
 * 4. **伤逝是状态触发，不是某个时机的事件**：任何让手牌变少、或让已损失体力
 *    变多的事都算；放弃过一次之后，状态再变还应该能再问。
 */

const JUEQING = 'jueqing'
const SHANGSHI = 'shangshi'

/** 上次问【伤逝】时的状态指纹。状态没变就不再重复问。 */
const SHANGSHI_ASKED = 'shangshi-asked'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 绝情 ───────────────────────────────

registerSkillRuntime({
  id: JUEQING,
  replacesDamageWithHpLoss() {
    /*
     * 锁定技，无条件：**他造成的**所有伤害都变成等量的失去体力。
     *
     * 属性、牌名、目标都不影响这条判断——火【杀】、雷【杀】、决斗、火攻、
     * 技能伤害一律照换。换完之后连环不传导、藤甲不加不减、
     * 「受到伤害后」那批时机一个都不跑，因为最终不是伤害。
     */
    return true
  },
})

// ─────────────────────────────── 伤逝 ───────────────────────────────

/** 现在该补几张牌。0 表示条件不成立。 */
function shangshiShortfall(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return 0
  // 已损失体力值现算：上限会被减、会被加
  return Math.max(0, lostHpOf(state, ownerId) - owner.zones.hand.length)
}

registerSkillRuntime({
  id: SHANGSHI,
  triggers: [{
    /*
     * 挂在哪个事件上都不对——**任何**让手牌变少或让已损失体力变多的事都算。
     * 所以这里挂一批「可能改变这两个数」的时机，然后统一由指纹去重：
     * 一次拿走三张手牌只会问一次，因为那三张是同一次原子移动，
     * 排队的提示在牌桌干净之后才放出来，那时指纹只变了一次。
     */
    event: 'LoseCard',
    handle(host, ownerId) { queueCheck(host, ownerId) },
  }, {
    event: 'CardUsed',
    handle(host, ownerId) { queueCheck(host, ownerId) },
  }, {
    event: 'CardResponded',
    handle(host, ownerId) { queueCheck(host, ownerId) },
  }, {
    event: 'LoseHp',
    handle(host, ownerId) { queueCheck(host, ownerId) },
  }, {
    event: 'Damaged',
    handle(host, ownerId) { queueCheck(host, ownerId) },
  }, {
    event: 'MaxHpChange',
    handle(host, ownerId) { queueCheck(host, ownerId) },
  }, {
    event: 'GainCard',
    handle(host, ownerId) { queueCheck(host, ownerId) },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'check') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const shortfall = shangshiShortfall(host.state, ownerId)
    const fingerprint = handStateFingerprint(host.state, ownerId)
    if (shortfall <= 0) {
      // 条件不成立就把记号清掉：下次真的掉下来时还要能问
      delete owner.marks[SHANGSHI_ASKED]
      return
    }
    /*
     * 同一个状态只问一次。
     *
     * 指纹是「手牌数 / 已损失体力」，两个数任何一个变了就是新状态，
     * 那时可以再问——**放弃一次不该让他整局都不能再发动**。
     */
    if (owner.marks[SHANGSHI_ASKED] === fingerprintKey(fingerprint)) return
    host.askSkill({
      skillId: SHANGSHI, ownerId, step: 'check', data: { fingerprint },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【伤逝】：将手牌补至 ${lostHpOf(host.state, ownerId)} 张（摸 ${shortfall} 张）？`,
        timeoutMs: 20_000, optional: true,
        options: [
          { id: 'draw', label: `摸 ${shortfall} 张牌` },
          // 可选的单选请求必须给一条真的「不发动」，否则玩家点不了放弃
          { id: 'cancel', label: '不发动' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'check') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    // 无论答什么都记下「这个状态已经问过了」，避免同一状态反复弹
    owner.marks[SHANGSHI_ASKED] = fingerprintKey(String(resolution.data.fingerprint ?? ''))
    if ((response.payload as { optionId?: string }).optionId !== 'draw') return
    // 落地前重新算一次：发问期间手牌和体力都可能又变了
    const shortfall = shangshiShortfall(host.state, ownerId)
    if (shortfall <= 0) return
    host.dispatch('SkillActivated', {
      skillId: SHANGSHI, skillName: '伤逝', playerId: ownerId,
      logText: `${owner.nickname}发动【伤逝】，将手牌补至 ${lostHpOf(host.state, ownerId)} 张`,
    }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, shortfall, (name, payload) => { host.dispatch(name, payload) })
  },
})

/**
 * 把指纹压成一个数字存进 marks。
 *
 * `marks` 只存数字，而这里要记的是一个「状态标识」——用一个稳定的哈希，
 * 目的只是「和上次一样不一样」，不需要能反解。
 */
function fingerprintKey(fingerprint: string): number {
  let hash = 0
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash = (hash * 31 + fingerprint.charCodeAt(index)) % 1_000_003
  }
  // 0 表示「没记过」，所以整体加一避开它
  return hash + 1
}

function queueCheck(host: SkillHost, ownerId: PlayerId): void {
  /*
   * **排队复查，不当场问**。
   *
   * 一次原子的多张移动（顺手牵羊拿走三张、一次弃四张）会派发一条事件，
   * 但中途状态是不完整的；排队的东西要等牌桌干净才放出来，
   * 那时候读到的才是这次移动**完成之后**的状态。
   */
  host.queueSkill({ skillId: SHANGSHI, ownerId, step: 'check', data: {} })
}

export const ZHANGCHUNHUA: CharacterDefinition = {
  id: 'zhangchunhua',
  name: '张春华',
  kingdom: 'wei',
  gender: 'female',
  maxHp: 3,
  pack: 'yjcm2011',
  skills: [
    {
      id: JUEQING,
      name: '绝情',
      description: '锁定技，你造成的伤害均改为等量的失去体力。',
    },
    {
      id: SHANGSHI,
      name: '伤逝',
      description: '若你的手牌数小于你已损失的体力值，你可以将手牌补至等同于你已损失的体力值。',
    },
  ],
}
