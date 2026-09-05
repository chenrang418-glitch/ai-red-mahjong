import { loseHp, loseMaxHp } from '../../engine/hp'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { recover } from '../../engine/recover'
import type { ChooseOptionRequest } from '../../engine/requests'
import { effectiveCardSuit, registerSkillRuntime, type ViewAsOption } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import { effectiveGenderOf, effectiveKingdomOf } from '../../engine/huashen'
import type { CharacterDefinition } from './types'

/**
 * 林包·董卓。本项目自研表述。8 体力。
 *
 * 【酒池】「你可以将一张♠手牌当【酒】使用。」
 * 【肉林】「锁定技，当你使用【杀】指定女性角色为目标后／成为女性角色使用【杀】的目标后，
 *   该角色／你需连续使用两张【闪】才能抵消。」
 * 【崩坏】「锁定技，结束阶段，若你不是全场体力值最低的角色，
 *   你选择一项：1.失去 1 点体力；2.减 1 点体力上限。」
 * 【暴虐】「主公技，当其他群势力角色造成伤害后，其可以进行一次判定，
 *   若结果为♠，你回复 1 点体力。」
 *
 * 暴虐的发动者是**造成伤害的那名群势力角色**，不是董卓——和曹丕【颂威】一样，
 * 文本里的「其」指的是别人，搞反了就变成董卓单方面白嫖。
 */

export const JIUCHI = 'jiuchi'
export const ROULIN = 'roulin'
export const BENGHUAI = 'benghuai'
export const BAONUE = 'baonue'

const BAONUE_TAG = 'baonue'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function isFemale(state: SanguoshaState, playerId: PlayerId): boolean {
  return effectiveGenderOf(state, playerId) === 'female'
}

// ─────────────────────────────── 酒池 ───────────────────────────────

/**
 * 黑桃**手牌**当【酒】用。
 *
 * 花色读 `effectiveCardSuit`，不是 `card.suit`：花色改写（小乔【红颜】）
 * 对酒池同样生效，项目里花色只有这一个口径。
 *
 * 「每回合限一次」不用在这里写：转化出来的【酒】走的是和实体酒**完全相同**的
 * 使用管线（`declaredCardActions` 里那条 `wineUses < 1`），
 * 所以拿一手黑桃也只能喝一次。
 */
registerSkillRuntime({
  id: JIUCHI,
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    if (!owner) return []
    const options: ViewAsOption[] = []
    // 只认手牌：技能文本写的是「♠手牌」，装备区的黑桃不行
    for (const cardId of owner.zones.hand) {
      const card = state.cards[cardId]
      if (!card || card.name === '酒') continue
      if (effectiveCardSuit(state, ownerId, cardId) !== 'spade') continue
      options.push({ asCardName: '酒', cardId, label: `将【${card.name}】当【酒】使用` })
    }
    return options
  },
})

// ─────────────────────────────── 肉林 ───────────────────────────────

/**
 * 锁定技，两个方向都生效：董卓砍女性、女性砍董卓，被砍的一方都要两张【闪】。
 *
 * 走公共的 `dodgeResponsesFor`，和吕布【无双】汇到同一个 `slashDodgeRequirement`，
 * 那里取的是 **max 不是相加**——两个技能撞在一起仍然是两张闪，不是四张。
 *
 * 「连续使用两张【闪】」是两次独立的响应：八卦阵、倾国、龙胆、蛊惑
 * 每一张都要单独走一遍，判定成功一次不能把整次肉林杀抵消掉。
 * 这一条由【杀】的结算管线负责，这里只报数字。
 */
registerSkillRuntime({
  id: ROULIN,
  dodgeResponsesFor(state, ownerId, sourceId, targetId) {
    // 董卓出杀打女性
    if (ownerId === sourceId && targetId !== ownerId && isFemale(state, targetId)) return 2
    // 女性出杀打董卓
    if (ownerId === targetId && sourceId !== ownerId && isFemale(state, sourceId)) return 2
    return 1
  },
})

// ─────────────────────────────── 崩坏 ───────────────────────────────

const BENGHUAI_LOSE_HP = 'benghuai-lose-hp'
const BENGHUAI_LOSE_MAX = 'benghuai-lose-max'

/**
 * 「若你**不是**全场体力值最低的角色」。
 *
 * 并列最低也算「是最低」，不触发。写成 `有人体力 <= 董卓` 是错的，
 * 那样并列时会误触发。
 */
function isLowestHp(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return true
  const alive = state.players.filter((player) => player.alive)
  const lowest = Math.min(...alive.map((player) => player.hp))
  return owner.hp <= lowest
}

registerSkillRuntime({
  id: BENGHUAI,
  announcesSelf: true,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      if (host.state.skillResolution) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (isLowestHp(host.state, ownerId)) return
      host.askSkill({
        skillId: BENGHUAI, ownerId, step: 'choose',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【崩坏】：你不是全场体力最低的角色，选择一项',
          // 锁定技，必须选一项，不能放弃
          timeoutMs: 20_000, optional: false,
          options: [
            { id: BENGHUAI_LOSE_HP, label: '失去 1 点体力' },
            { id: BENGHUAI_LOSE_MAX, label: '减 1 点体力上限' },
          ],
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId: string }).optionId
    host.dispatch('SkillActivated', {
      skillId: BENGHUAI, skillName: '崩坏', playerId: ownerId, result: optionId,
      logText: `${owner.nickname}发动【崩坏】，${optionId === BENGHUAI_LOSE_MAX ? '减 1 点体力上限' : '失去 1 点体力'}`,
    }, { sourceId: ownerId })
    if (optionId === BENGHUAI_LOSE_MAX) {
      // 减上限走公共入口：体力裁剪、濒死、手牌上限全在那里统一处理
      loseMaxHp(host, ownerId, 1, '崩坏')
      return
    }
    // 失去体力**不是**受到伤害，不触发奸雄、刚烈、节命这些「受伤后」的技能
    loseHp(host, ownerId, 1, '崩坏')
  },
})

// ─────────────────────────────── 暴虐 ───────────────────────────────

registerJudgmentContinuation(BAONUE_TAG, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const sourceId = data.sourceId as PlayerId
  const owner = host.state.players.find((candidate) => candidate.id === ownerId)
  if (!owner?.alive) return
  if (judged.suit !== 'spade') return
  host.dispatch('SkillActivated', {
    skillId: BAONUE, skillName: '暴虐', playerId: sourceId, targetIds: [ownerId], result: 'recover',
    logText: `【暴虐】判定为黑桃，${owner.nickname}回复 1 点体力`,
  }, { sourceId, targetId: ownerId })
  // 回复走公共入口；满血时 recover 自己会返回 0，不需要额外判断
  recover(host as never, ownerId, 1, sourceId)
})

/**
 * 主公技。**发动者是造成伤害的那名群势力角色**，所以问句发给他。
 *
 * 挂在 `Damaged` 上排队：一次伤害事件问一次，挨 2 点也只判一次
 * （文本是「造成伤害后」，不是「每造成 1 点伤害」）。
 * 判定走统一的 `performJudgment`，所以鬼才、鬼道照常能改判。
 */
registerSkillRuntime({
  id: BAONUE,
  lord: true,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const owner = playerOf(host.state, ownerId)
      // 主公技只在坐主公位时生效
      if (!owner?.alive || owner.identity !== 'lord') return
      const sourceId = context.event.sourceId
      // 「其他群势力角色」：董卓自己造成的伤害不算，没有来源的伤害也不算
      if (!sourceId || sourceId === ownerId) return
      const source = playerOf(host.state, sourceId)
      if (!source?.alive || !source.characterId) return
      if (effectiveKingdomOf(host.state, source.id) !== 'qun') return
      host.queueSkill({ skillId: BAONUE, ownerId, step: 'ask', data: { sourceId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.identity !== 'lord') return
    const sourceId = prompt.data.sourceId as PlayerId
    const source = playerOf(host.state, sourceId)
    if (!source?.alive) return
    host.askSkill({
      skillId: BAONUE, ownerId, step: 'ask', data: { sourceId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option',
        // 决定权在造成伤害的那名群势力角色手上，不是董卓
        playerId: sourceId,
        prompt: `发动【暴虐】？进行一次判定，若为黑桃则${owner.nickname}回复 1 点体力`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动暴虐' }, { id: 'no', label: '放弃' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId: string }).optionId !== 'yes') return
    const sourceId = resolution.data.sourceId as PlayerId
    const source = playerOf(host.state, sourceId)
    if (!source?.alive) return
    // 判定的「发起者」是那名群势力角色：改判、天妒这些都按他来算
    performJudgment(host, sourceId, '暴虐', { tag: BAONUE_TAG, data: { ownerId, sourceId } })
  },
})

export const DONGZHUO: CharacterDefinition = {
  id: 'dongzhuo',
  name: '董卓',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 8,
  pack: 'forest',
  skills: [
    { id: JIUCHI, name: '酒池', description: '你可以将一张黑桃手牌当【酒】使用。' },
    { id: ROULIN, name: '肉林', description: '锁定技，当你使用【杀】指定女性角色为目标后，或成为女性角色使用【杀】的目标后，该角色或你需连续使用两张【闪】才能抵消。' },
    { id: BENGHUAI, name: '崩坏', description: '锁定技，结束阶段，若你不是全场体力值最低的角色，你须选择一项：失去 1 点体力，或减 1 点体力上限。' },
    { id: BAONUE, name: '暴虐', description: '主公技，当其他群势力角色造成伤害后，其可以进行一次判定，若结果为黑桃，你回复 1 点体力。' },
  ],
}
