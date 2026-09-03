import { resolveDamage } from '../../engine/damage'
import { canTarget } from '../../engine/distance'
import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 神话再临·火包。
 *
 * 只放技能全部实现完的武将。**没实现的宁可不登记**——
 * 能选到却发动不了比根本选不到更糟。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

// —— 典韦【强袭】——
//
// 采用**经典火包版**：出牌阶段限一次，失去 1 点体力或弃置一张武器牌，
// 然后对攻击范围内的一名其他角色造成 1 点伤害。
// 界限突破版是「限两次 + 本阶段未被强袭过」，这里不混进来。

const QIANGXI = 'qiangxi'

/** 强袭打得到谁：自己攻击范围内的其他存活角色。 */
function qiangxiTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((player) => player.alive && player.id !== ownerId && canTarget(state, ownerId, player.id))
    .map((player) => player.id)
}

/** 两种代价各自是否付得起。武器必须真的在武器栏，不能拿别的装备顶。 */
function qiangxiCosts(state: SanguoshaState, ownerId: PlayerId): { hp: boolean; weapon: boolean } {
  const owner = playerOf(state, ownerId)
  return { hp: owner.alive, weapon: owner.zones.equipment.weapon !== null }
}

function payQiangxiCost(host: SkillHost, ownerId: PlayerId, useWeapon: boolean): boolean {
  const owner = playerOf(host.state, ownerId)
  if (useWeapon) {
    const weaponId = owner.zones.equipment.weapon
    if (!weaponId) return false
    moveCard(host.state, weaponId, { kind: 'equipment', playerId: ownerId, slot: 'weapon' }, { kind: 'discardPile' })
    host.dispatch('LoseEquipment', { playerId: ownerId, cardId: weaponId, slot: 'weapon', reason: '强袭' }, { targetId: ownerId, cardIds: [weaponId] })
    return true
  }
  // 失去体力不是受到伤害：不触发受伤时机，但可能进入濒死。走统一入口。
  loseHp(host, ownerId, 1, '强袭')
  return true
}

function askQiangxiTarget(host: SkillHost, ownerId: PlayerId, useWeapon: boolean): void {
  const candidateIds = qiangxiTargets(host.state, ownerId)
  if (candidateIds.length === 0) return
  host.askSkill({
    skillId: QIANGXI,
    ownerId,
    step: 'target',
    data: { useWeapon },
    build: (requestId): ChooseTargetsRequest => ({
      id: requestId,
      kind: 'choose-targets',
      playerId: ownerId,
      prompt: '发动【强袭】：对攻击范围内的一名角色造成 1 点伤害',
      timeoutMs: 20_000,
      optional: false,
      candidateIds,
      min: 1,
      max: 1,
    }),
  })
}

registerSkillRuntime({
  id: QIANGXI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner.alive) return []
    if (usedThisTurn(state, ownerId, QIANGXI)) return []
    // 打不到人就没有发动的意义，直接不出现在合法动作里
    if (qiangxiTargets(state, ownerId).length === 0) return []
    const costs = qiangxiCosts(state, ownerId)
    if (!costs.hp && !costs.weapon) return []
    return [{ id: `skill:${QIANGXI}`, label: '发动【强袭】：失去一点体力或弃武器，对一名角色造成一点伤害' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${QIANGXI}`) throw new Error('强袭动作不匹配')
    // 先记账再发问：中途的每一步都可能因为休眠中断，标记必须在最早的时机落下，
    // 否则玩家可以靠取消发问把「限一次」刷成无限次。
    markUsedThisTurn(host.state, ownerId, QIANGXI)
    const costs = qiangxiCosts(host.state, ownerId)
    if (costs.hp && costs.weapon) {
      host.askSkill({
        skillId: QIANGXI,
        ownerId,
        step: 'cost',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId,
          kind: 'choose-option',
          playerId: ownerId,
          prompt: '【强袭】：选择代价',
          timeoutMs: 20_000,
          optional: false,
          options: [
            { id: 'hp', label: '失去一点体力' },
            { id: 'weapon', label: '弃置武器牌' },
          ],
        }),
      })
      return
    }
    // 只有一种代价付得起就不必多问一次
    const useWeapon = costs.weapon
    if (!payQiangxiCost(host, ownerId, useWeapon)) return
    // 付代价可能让自己进入濒死，那时候不该接着发问
    if (host.state.dying) return
    askQiangxiTarget(host, ownerId, useWeapon)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const useWeapon = (response.payload as { optionId: string }).optionId === 'weapon'
      if (!payQiangxiCost(host, ownerId, useWeapon)) return
      if (host.state.dying) return
      askQiangxiTarget(host, ownerId, useWeapon)
      return
    }
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
      const target = host.state.players.find((candidate) => candidate.id === targetId)
      // 从发问到回答之间局面可能已经变了，再确认一次
      if (!target?.alive) return
      if (!canTarget(host.state, ownerId, targetId)) return
      // 走统一伤害入口：濒死、死亡、伤害时机、动画、AI 信念全靠它。
      // SkillHost 的形状（state + rng + dispatch）已经满足 DamageEngineHost，不另造入口。
      resolveDamage(host, { sourceId: ownerId, targetId, amount: 1, cardName: '强袭' })
    }
  },
})

// —— 颜良文丑【双雄】——
//
// 经典火包版：摸牌阶段可以改为判定并获得判定牌，本回合可将与判定牌
// 颜色不同的手牌当【决斗】使用。判定牌颜色只存在当前回合，回合结束清除。

registerSkillRuntime({
  id: 'shuangxiong',
  triggers: [
    {
      event: 'DrawPhase',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: string }
        if (payload.playerId !== ownerId || host.state.skillResolution) return
        context.cancel()
        host.askSkill({
          skillId: 'shuangxiong', ownerId, step: 'ask',
          build: (requestId): ChooseOptionRequest => ({
            id: requestId, kind: 'choose-option', playerId: ownerId,
            prompt: '发动【双雄】？改为判定并获得判定牌，本回合可将异色手牌当【决斗】使用',
            timeoutMs: 20_000, optional: false,
            options: [{ id: 'yes', label: '发动双雄' }, { id: 'no', label: '正常摸两张牌' }],
          }),
        })
      },
    },
    {
      event: 'TurnEnd',
      handle(host, ownerId) { delete playerOf(host.state, ownerId).marks.shuangxiong },
    },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const optionId = (response.payload as { optionId: string }).optionId
    if (optionId !== 'yes') {
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
      return
    }
    performJudgment(host, ownerId, '双雄', { tag: SHUANGXIONG_TAG, data: { ownerId } })
  },
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const judgedColor = owner.marks.shuangxiong === 1 ? 'red' : owner.marks.shuangxiong === 2 ? 'black' : null
    if (!judgedColor) return []
    return owner.zones.hand
      .filter((cardId) => state.cards[cardId]?.color !== judgedColor)
      .map((cardId) => ({ asCardName: '决斗', cardId, label: `将【${state.cards[cardId].name}】当【决斗】使用` }))
  },
})

const SHUANGXIONG_TAG = 'shuangxiong'

registerJudgmentContinuation(SHUANGXIONG_TAG, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const owner = playerOf(host.state, ownerId)
  if (host.state.zones.discardPile.includes(judged.id)) {
    moveCard(host.state, judged.id, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [judged.id], reason: '双雄', revealed: true }, { targetId: ownerId, cardIds: [judged.id] })
  }
  owner.marks.shuangxiong = judged.color === 'red' ? 1 : 2
})

// 荀彧要用公共拼点，单独一个文件
import { XUNYU } from './fire-xunyu'
// 太史慈同样是拼点消费者
import { TAISHICI } from './fire-taishici'
// 袁绍的乱击是多牌转化，血裔是主公技，同样单独一个文件
import { YUANSHAO } from './fire-yuanshao'
import { PANGTONG } from './fire-pangtong'
import { WOLONG_ZHUGE } from './fire-wolongzhuge'

export const FIRE_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'yanliangwenchou',
    name: '颜良文丑',
    kingdom: 'qun',
    gender: 'male',
    maxHp: 4,
    pack: 'fire',
    skills: [{
      id: 'shuangxiong',
      name: '双雄',
      description: '摸牌阶段，你可以改为进行一次判定并获得判定牌；本回合你可以将与判定牌颜色不同的一张手牌当【决斗】使用。',
    }],
  },
  {
    id: 'pangde',
    name: '庞德',
    kingdom: 'qun',
    gender: 'male',
    maxHp: 4,
    pack: 'fire',
    skills: [
      // 马术直接复用马超那套 distanceModifier，没有另写一份庞德专属的距离判断
      { id: 'mashu', name: '马术', description: '锁定技，你计算与其他角色的距离时，始终减一。' },
      { id: 'mengjin', name: '猛进', description: '当你使用的【杀】被【闪】抵消后，你可以弃置一张牌，然后弃置该角色的一张牌。' },
    ],
  },
  {
    id: 'dianwei',
    name: '典韦',
    kingdom: 'wei',
    gender: 'male',
    maxHp: 4,
    pack: 'fire',
    skills: [{
      id: QIANGXI,
      name: '强袭',
      description: '出牌阶段限一次，你可以失去一点体力或弃置一张武器牌，然后对你攻击范围内的一名其他角色造成一点伤害。',
    }],
  },
  XUNYU,
  TAISHICI,
  YUANSHAO,
  PANGTONG,
  WOLONG_ZHUGE,
] as const
