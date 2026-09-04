import { flipCharacter } from '../../engine/character-state'
import { claimDeathCards, heldDeathCards, releaseDeathCards } from '../../engine/death-claim'
import { drawCards } from '../../engine/draw'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import { effectiveKingdomOf } from '../../engine/huashen'
import type { CharacterDefinition } from './types'

/**
 * 林包·曹丕。经典「神话再临·林」首版，不是界曹丕。
 *
 * 【行殇】「当其他角色死亡时，你可以获得其所有牌。」
 * 【放逐】「当你受到伤害后，你可以令一名其他角色摸 X 张牌（X 为你已损失的体力值）并翻面。」
 * 【颂威】「主公技，当其他魏势力角色的黑色判定牌生效后，**其**可以令你摸一张牌。」
 *
 * 颂威的发动者是**那名魏势力角色**，不是曹丕——文本里的「其」指的是判定的人。
 * 搞反了会变成曹丕单方面白嫖，规则和体验都不对。
 */

export const XINGSHANG = 'xingshang'
export const FANGZHU = 'fangzhu'
export const SONGWEI = 'songwei'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** X = 已损失体力值。不写死 3：主公体力上限会 +1。 */
function lostHp(state: SanguoshaState, playerId: PlayerId): number {
  const owner = playerOf(state, playerId)
  if (!owner) return 0
  return Math.max(0, owner.maxHp - owner.hp)
}

// ─────────────────────────────── 行殇 ───────────────────────────────

/**
 * 「获得其所有牌」= 手牌 + 装备区 + 判定区，一张不留。
 *
 * 曹丕这边只做两件事：声明认领意向、拿到 Death 之后问玩家要不要拿。
 * 牌怎么暂存、怎么退回弃牌堆全在 `engine/death-claim.ts`，
 * 死亡流程里没有一行 caopi。
 *
 * **行殇改变不了死亡结果**。它挂在 Death 之后，那时候角色已经确定阵亡；
 * 周泰【不屈】、庞统【涅槃】是在更早的濒死窗口把人救回来的，
 * 那两种情况根本不会走到这里。
 */
registerSkillRuntime({
  id: XINGSHANG,
  claimsDeathCards(state, ownerId, deadId) {
    const owner = playerOf(state, ownerId)
    // 「其他角色死亡时」——自己死了不能对自己发动
    return Boolean(owner?.alive) && ownerId !== deadId
  },
  triggers: [{
    event: 'Death',
    handle(host, ownerId) {
      const claim = host.state.deathClaim
      if (!claim || claim.claimantId !== ownerId || claim.skillId !== XINGSHANG) return
      // 死亡结算还没走完（身份奖惩、胜负判定都在后面），只抓事实排队，
      // 等牌局回到干净状态再问
      host.queueSkill({ skillId: XINGSHANG, ownerId, step: 'ask', data: { deadId: claim.deadId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const claim = host.state.deathClaim
    // 排队期间挂账可能已经被别的路径收掉了
    if (!claim || claim.claimantId !== ownerId || claim.skillId !== XINGSHANG) return
    const owner = playerOf(host.state, ownerId)
    // 曹丕自己也没了：牌不能给死人，直接归弃牌堆
    if (!owner?.alive) {
      releaseDeathCards(host)
      return
    }
    const cards = heldDeathCards(host.state)
    if (cards.length === 0) {
      releaseDeathCards(host)
      return
    }
    const dead = playerOf(host.state, prompt.data.deadId as PlayerId)
    host.askSkill({
      skillId: XINGSHANG, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `发动【行殇】？获得${dead?.nickname ?? '阵亡角色'}的全部 ${cards.length} 张牌`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动行殇' }, { id: 'no', label: '放弃' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId: string }).optionId !== 'yes') {
      // 不拿就让牌回到正常死亡清牌的去向
      releaseDeathCards(host)
      return
    }
    const taken = claimDeathCards(host, ownerId, '行殇')
    if (taken.length === 0) return
    host.dispatch('SkillActivated', {
      skillId: XINGSHANG, skillName: '行殇', playerId: ownerId, result: 'claim', cardIds: taken,
      logText: `${playerOf(host.state, ownerId)?.nickname}发动【行殇】，获得阵亡角色的 ${taken.length} 张牌`,
    }, { sourceId: ownerId, cardIds: taken })
  },
})

// ─────────────────────────────── 放逐 ───────────────────────────────

/**
 * 「当你受到伤害后」——**一次伤害事件问一次**，不是每受到 1 点问一次。
 * 挨了 2 点只发动一次，X 也只算一遍。
 */
registerSkillRuntime({
  id: FANGZHU,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      host.queueSkill({ skillId: FANGZHU, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    // X 为 0 时发动没有任何意义（既不摸牌也说不上「令其摸 X 张」），不弹空窗口
    if (lostHp(host.state, ownerId) <= 0) return
    const candidateIds = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: FANGZHU, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `发动【放逐】？令一名其他角色摸 ${lostHp(host.state, ownerId)} 张牌并翻面`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动放逐' }, { id: 'no', label: '放弃' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId: string }).optionId !== 'yes') return
      const candidateIds = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: FANGZHU, ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【放逐】：令谁摸 ${lostHp(host.state, ownerId)} 张牌并翻面？`,
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      // X 现算：受伤到结算之间可能插进回复或别的伤害
      const count = lostHp(host.state, ownerId)
      host.dispatch('SkillActivated', {
        skillId: FANGZHU, skillName: '放逐', playerId: ownerId, targetIds: [targetId], result: 'invoke',
        logText: `${playerOf(host.state, ownerId)?.nickname}发动【放逐】，令${target.nickname}摸 ${count} 张牌并翻面`,
      }, { sourceId: ownerId, targetId })
      /*
       * **先摸后翻，顺序不能反。**摸牌可能触发别的时机，
       * 先翻面会让那些时机看到的是已经翻过去的状态。
       */
      if (count > 0) drawCards(host.state, host.rng, targetId, count, (name, payload) => { host.dispatch(name, payload) })
      // 「翻面」是翻到另一面：正面翻成背面，背面也会翻回正面，不是强制翻成背面
      flipCharacter(host, targetId, '放逐')
    }
  },
})

// ─────────────────────────────── 颂威 ───────────────────────────────

/**
 * 主公技。**发动者是那名魏势力角色**，所以问句发给他，不是发给曹丕。
 *
 * 挂在 `JudgeResult` 上而不是翻开判定牌的那一刻：鬼才、鬼道可能改判，
 * `JudgeResult` 派发时颜色已经是**改判之后的最终结果**。
 * 真正的发问再往后推一步（排队），这样「生效后」也成立。
 */
registerSkillRuntime({
  id: SONGWEI,
  lord: true,
  triggers: [{
    event: 'JudgeResult',
    handle(host, ownerId, context) {
      const owner = playerOf(host.state, ownerId)
      // 主公技只在坐主公位时生效
      if (!owner?.alive || owner.identity !== 'lord') return
      const payload = context.event.payload as { playerId?: PlayerId; color?: string }
      const judgingId = payload.playerId
      if (!judgingId || judgingId === ownerId) return
      if (payload.color !== 'black') return
      const judging = playerOf(host.state, judgingId)
      if (!judging?.alive || !judging.characterId) return
      if (effectiveKingdomOf(host.state, judging.id) !== 'wei') return
      // 判定的效果还没结算完，这里只抓事实排队
      host.queueSkill({ skillId: SONGWEI, ownerId, step: 'ask', data: { judgingId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.identity !== 'lord') return
    const judgingId = prompt.data.judgingId as PlayerId
    const judging = playerOf(host.state, judgingId)
    if (!judging?.alive) return
    host.askSkill({
      skillId: SONGWEI, ownerId, step: 'ask', data: { judgingId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option',
        // 决定权在判定的那名魏势力角色手上，不是曹丕
        playerId: judgingId,
        prompt: `发动【颂威】？令${owner.nickname}摸一张牌`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '令主公摸一张牌' }, { id: 'no', label: '放弃' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const judgingId = resolution.data.judgingId as PlayerId
    host.dispatch('SkillActivated', {
      skillId: SONGWEI, skillName: '颂威', playerId: judgingId, targetIds: [ownerId], result: 'draw',
      logText: `${playerOf(host.state, judgingId)?.nickname}发动【颂威】，令${owner.nickname}摸一张牌`,
    }, { sourceId: judgingId, targetId: ownerId })
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const CAOPI: CharacterDefinition = {
  id: 'caopi',
  name: '曹丕',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'forest',
  skills: [
    { id: XINGSHANG, name: '行殇', description: '当其他角色死亡时，你可以获得其所有牌。' },
    { id: FANGZHU, name: '放逐', description: '当你受到伤害后，你可以令一名其他角色摸 X 张牌（X 为你已损失的体力值）并将其武将牌翻面。' },
    { id: SONGWEI, name: '颂威', description: '主公技，当其他魏势力角色的黑色判定牌生效后，其可以令你摸一张牌。' },
  ],
}
