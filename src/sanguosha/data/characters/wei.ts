import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { performJudgment } from '../../engine/judgment'
import { recover } from '../../engine/recover'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest, GameResponse } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 需要向玩家发问的武将。
 *
 * 这些技能都只在**可以安全挂起**的时机发问——回合开始、摸牌阶段开始、出牌阶段主动发动。
 * 伤害结算中途（奸雄、反馈、刚烈）不在这里：那时候挂起会让后续结算和玩家的回答错位，
 * 得先让伤害结算本身支持中断。宁可少几个武将，也不放技能描述对不上实现的空壳。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

function draw(host: SkillHost, playerId: PlayerId, count: number, reason: string): void {
  const owner = playerOf(host.state, playerId)
  const drawn: CardId[] = []
  for (let index = 0; index < count; index += 1) {
    const cardId = host.state.zones.drawPile.shift()
    if (!cardId) break
    owner.zones.hand.push(cardId)
    drawn.push(cardId)
  }
  if (drawn.length > 0) host.dispatch('GainCard', { playerId, cardIds: drawn, reason }, { targetId: playerId, cardIds: drawn })
}

function yesNo(requestId: string, playerId: PlayerId, prompt: string): ChooseOptionRequest {
  return {
    id: requestId,
    kind: 'choose-option',
    playerId,
    prompt,
    timeoutMs: 20_000,
    optional: true,
    options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
  }
}

function chose(response: GameResponse, optionId: string): boolean {
  return (response.payload as { optionId: string }).optionId === optionId
}

// —— 甄姬【洛神】——
registerSkillRuntime({
  id: 'luoshen',
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: string; phase?: string }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      if (host.state.skillResolution) return
      host.askSkill({
        skillId: 'luoshen',
        ownerId,
        step: 'ask',
        build: (requestId) => yesNo(requestId, ownerId, '发动【洛神】？判定为黑色则获得判定牌，并可再次发动'),
      })
    },
  }],
  resume(host, ownerId, _resolution, response) {
    if (!chose(response, 'yes')) return
    const owner = playerOf(host.state, ownerId)
    if (!owner.alive) return
    // 洛神是一次真正的判定，走统一入口，判定相关的时机才对得上
    const judged = performJudgment(host, ownerId, '洛神')
    if (judged.color !== 'black') return
    // performJudgment 结束时判定牌已经进了弃牌堆，从那里取回来
    moveCard(host.state, judged.id, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [judged.id], reason: '洛神' }, { targetId: ownerId, cardIds: [judged.id] })
    host.askSkill({
      skillId: 'luoshen',
      ownerId,
      step: 'ask',
      build: (requestId) => yesNo(requestId, ownerId, '再次发动【洛神】？'),
    })
  },
})

// —— 许褚【裸衣】——
registerSkillRuntime({
  id: 'luoyi',
  triggers: [
    {
      event: 'DrawPhase',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: string }
        if (payload.playerId !== ownerId) return
        if (host.state.skillResolution) return
        // 接管摸牌：无论发不发动，牌都由技能补上，引擎不再默认摸两张
        context.cancel()
        host.askSkill({
          skillId: 'luoyi',
          ownerId,
          step: 'ask',
          build: (requestId) => yesNo(requestId, ownerId, '发动【裸衣】？少摸一张牌，本回合【杀】与【决斗】伤害 +1'),
        })
      },
    },
    {
      event: 'TurnEnd',
      handle(host, ownerId) {
        // 标记只在本回合有效，回合一结束就抹掉，不能留到下个回合
        delete playerOf(host.state, ownerId).marks.luoyi
      },
    },
  ],
  resume(host, ownerId, _resolution, response) {
    const invoked = chose(response, 'yes')
    if (invoked) playerOf(host.state, ownerId).marks.luoyi = 1
    draw(host, ownerId, invoked ? 1 : 2, invoked ? '裸衣' : 'draw')
  },
})

// —— 张辽【突袭】——
registerSkillRuntime({
  id: 'tuxi',
  triggers: [{
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: string }
      if (payload.playerId !== ownerId) return
      if (host.state.skillResolution) return
      // 没人有手牌时突袭无从发动，照常摸牌
      if (tuxiCandidates(host.state, ownerId).length === 0) return
      context.cancel()
      host.askSkill({
        skillId: 'tuxi',
        ownerId,
        step: 'ask',
        build: (requestId) => yesNo(requestId, ownerId, '发动【突袭】？放弃摸牌，改为获得至多两名角色各一张手牌'),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if (!chose(response, 'yes')) {
        draw(host, ownerId, 2, 'draw')
        return
      }
      const candidateIds = tuxiCandidates(host.state, ownerId)
      host.askSkill({
        skillId: 'tuxi',
        ownerId,
        step: 'targets',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId,
          kind: 'choose-targets',
          playerId: ownerId,
          prompt: '选择至多两名角色，各获得其一张手牌',
          timeoutMs: 20_000,
          optional: false,
          candidateIds,
          min: 1,
          max: Math.min(2, candidateIds.length),
        }),
      })
      return
    }

    const targetIds = (response.payload as { targetIds: PlayerId[] }).targetIds
    const taken: CardId[] = []
    for (const targetId of targetIds) {
      const victim = playerOf(host.state, targetId)
      if (victim.zones.hand.length === 0) continue
      // 手牌是暗的，抽哪一张由局内 RNG 决定，回放才对得上
      const cardId = victim.zones.hand[host.rng.nextInt(victim.zones.hand.length)]
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: '突袭' }, { targetId, cardIds: [cardId] })
      taken.push(cardId)
    }
    if (taken.length > 0) host.dispatch('GainCard', { playerId: ownerId, cardIds: taken, reason: '突袭' }, { targetId: ownerId, cardIds: taken })
  },
})

function tuxiCandidates(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((player) => player.alive && player.id !== ownerId && player.zones.hand.length > 0)
    .map((player) => player.id)
}

// —— 华佗【青囊】——
registerSkillRuntime({
  id: 'qingnang',
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner.alive || owner.zones.hand.length === 0) return []
    // 出牌阶段限一次，用过就不再出现在合法动作里
    if (usedThisTurn(state, ownerId, 'qingnang')) return []
    // 场上没人受伤时发动没有意义，也不该给出这个按钮
    if (!state.players.some((player) => player.alive && player.hp < player.maxHp)) return []
    return [{ id: 'skill:qingnang', label: '发动【青囊】：弃一张手牌，令一名已受伤角色回复一点体力' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:qingnang') throw new Error('青囊动作不匹配')
    const owner = playerOf(host.state, ownerId)
    host.askSkill({
      skillId: 'qingnang',
      ownerId,
      step: 'discard',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId,
        kind: 'choose-cards',
        playerId: ownerId,
        prompt: '弃置一张手牌',
        timeoutMs: 20_000,
        optional: false,
        purpose: 'skill',
        cardIds: [...owner.zones.hand],
        hiddenCardSlots: [],
        min: 1,
        max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      const owner = playerOf(host.state, ownerId)
      if (!owner.zones.hand.includes(cardId)) throw new Error('青囊弃置的牌不在手上')
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: '青囊' }, { sourceId: ownerId, cardIds: [cardId] })
      markUsedThisTurn(host.state, ownerId, 'qingnang')
      const candidateIds = host.state.players.filter((player) => player.alive && player.hp < player.maxHp).map((player) => player.id)
      // 弃牌之后场上一定还有受伤角色：弃牌本身不会让谁回满
      host.askSkill({
        skillId: 'qingnang',
        ownerId,
        step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId,
          kind: 'choose-targets',
          playerId: ownerId,
          prompt: '选择回复体力的角色',
          timeoutMs: 20_000,
          optional: false,
          candidateIds,
          min: 1,
          max: 1,
        }),
      })
      return
    }

    const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
    recover(host, targetId, 1, ownerId)
  },
})

export const WEI_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'zhenji',
    name: '甄姬',
    kingdom: 'wei',
    gender: 'female',
    maxHp: 3,
    pack: 'standard',
    skills: [
      { id: 'qingguo', name: '倾国', description: '你可以将一张黑色手牌当【闪】打出。' },
      { id: 'luoshen', name: '洛神', description: '回合开始阶段，你可以进行判定：若判定结果为黑色，你获得此牌，并可以再次发动【洛神】。' },
    ],
  },
  {
    id: 'xuchu',
    name: '许褚',
    kingdom: 'wei',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'luoyi', name: '裸衣', description: '摸牌阶段，你可以少摸一张牌，若如此做，本回合你使用【杀】或【决斗】造成的伤害 +1。' }],
  },
  {
    id: 'zhangliao',
    name: '张辽',
    kingdom: 'wei',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'tuxi', name: '突袭', description: '摸牌阶段，你可以放弃摸牌，改为获得至多两名其他角色的各一张手牌。' }],
  },
  {
    id: 'huatuo',
    name: '华佗',
    kingdom: 'qun',
    gender: 'male',
    maxHp: 3,
    pack: 'standard',
    skills: [
      { id: 'qingnang', name: '青囊', description: '出牌阶段限一次，你可以弃置一张手牌，令一名已受伤的角色回复一点体力。' },
      { id: 'jijiu', name: '急救', description: '你的回合外，你可以将一张红色手牌当【桃】使用。' },
    ],
  },
] as const
