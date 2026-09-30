// 武将册第39批，序号506–515。
import type { CharacterDefinition } from './types'
import { getCharacter } from './standard'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { SkillHost } from '../../engine/skills/runtime'
import { registerSkillRuntime, grantSkill, effectiveCardColor, effectiveCardSuit } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { loseHp, loseMaxHp } from '../../engine/hp'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { resolveDamage } from '../../engine/damage'
import { reshuffleDrawPile } from '../../engine/deck'
import { locateOwnedCard } from '../../engine/zones'
import { handleEquipmentLost } from '../../engine/equipment'
import { grantTurnSlashBonus } from '../../engine/slash-rules'

type B39State = SanguoshaState & { batch39?: Record<string, any> }
const stateOf = (host: SkillHost) => host.state as B39State
const playerOf = (state: SanguoshaState, id: PlayerId) => state.players.find(player => player.id === id)
const alive = (state: SanguoshaState) => state.players.filter(player => player.alive)
const others = (state: SanguoshaState, id: PlayerId) => alive(state).filter(player => player.id !== id)
const hand = (state: SanguoshaState, id: PlayerId): CardId[] => playerOf(state, id)?.zones.hand ?? []
const mark = (host: SkillHost, key: string, value: any) => {
  const state = stateOf(host)
  const values = state.batch39 ?? (state.batch39 = {})
  values[key] = value
}
const read = (state: B39State, key: string) => state.batch39?.[key]

function draw(host: SkillHost, playerId: PlayerId, count: number, reason: string): CardId[] {
  const ids = drawCards(host.state, host.rng, playerId, count, (name, payload) => host.dispatch(name, payload))
  if (ids.length) host.dispatch('GainCard', { playerId, cardIds: ids, reason }, { targetId: playerId, cardIds: ids })
  return ids
}
function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string, options: any[], data: any = {}, optional = true, requestPlayerId = ownerId) {
  host.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-option', playerId: requestPlayerId, prompt, timeoutMs: 25_000, optional, options }) })
}
function askCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, cardIds: CardId[], prompt: string, data: any = {}, min = 1, max = 1, optional = false) {
  host.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-cards', playerId: ownerId, prompt, timeoutMs: 25_000, optional, purpose: 'skill', cardIds, hiddenCardSlots: [], min, max }) })
}
function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, candidateIds: PlayerId[], prompt: string, data: any = {}, min = 1, max = 1, optional = false) {
  host.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 25_000, optional, candidateIds, min, max }) })
}
function discardHand(host: SkillHost, playerId: PlayerId, cardIds: CardId[], reason: string) {
  const owner = playerOf(host.state, playerId)
  const valid = [...new Set(cardIds)].filter(id => owner?.zones.hand.includes(id))
  for (const id of valid) moveCard(host.state, id, { kind: 'hand', playerId }, { kind: 'discardPile' })
  if (valid.length) host.dispatch('LoseCard', { playerId, cardIds: valid, reason }, { sourceId: playerId, cardIds: valid })
  return valid
}

// SP·徐庶【诛害】：在造成过伤害角色的结束阶段追加一次实体【杀】。
const ZHUHAI = 'zhuhai-sp-b39'
registerSkillRuntime({ id: ZHUHAI,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const data = context.event.payload as any
    if (data.phase !== 'finish' || data.playerId === ownerId || !playerOf(host.state, data.playerId)?.alive) return
    if (!host.state.damageHistory?.some(item => item.sourceId === data.playerId && item.turnNumber === host.state.turnNumber)) return
    const kills = hand(host.state, ownerId).filter(id => host.state.cards[id]?.name === '杀')
    if (!kills.length || !playerOf(host.state, ownerId)?.alive) return
    host.queueSkill({ skillId: ZHUHAI, ownerId, step: 'ask', data: { targetId: data.playerId } })
  } }],
  startQueued(host, ownerId, prompt) {
    const targetId = prompt.data.targetId as PlayerId
    if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive || !hand(host.state, ownerId).some(id => host.state.cards[id]?.name === '杀')) return
    askOption(host, ZHUHAI, ownerId, 'invoke', '【诛害】：是否对本回合造成过伤害的角色使用一张【杀】？', [{ id: 'yes', label: '使用【杀】' }, { id: 'no', label: '放弃' }], { targetId })
  },
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId
    if (resolution.step === 'invoke') {
      if ((response.payload as any).optionId !== 'yes') return
      const candidates = hand(host.state, ownerId).filter(id => host.state.cards[id]?.name === '杀')
      if (candidates.length && playerOf(host.state, targetId)?.alive) askCards(host, ZHUHAI, ownerId, 'card', candidates, '【诛害】：选择要使用的【杀】', { targetId })
      return
    }
    if (resolution.step === 'card') {
      const cardId = (response.payload as any).cardIds?.[0] as CardId
      if (cardId && hand(host.state, ownerId).includes(cardId) && playerOf(host.state, targetId)?.alive) host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: ZHUHAI, cardId, ignoreDistance: true })
    }
  },
})

// SP·徐庶【潜心】觉醒后获得【荐言】。
const QIANXIN = 'qianxin-sp-b39'
const JIANYAN = 'jianyan-sp-b39'
registerSkillRuntime({ id: QIANXIN, triggers: [{ event: 'AfterDamage', handle(host, ownerId, context) {
  const owner = playerOf(host.state, ownerId)
  if (context.event.sourceId !== ownerId) return
  if (owner) owner.awakenedSkills ??= []
  if (!owner?.alive || owner.hp >= owner.maxHp || owner.awakenedSkills.includes(QIANXIN)) return
  owner.awakenedSkills.push(QIANXIN)
  host.dispatch('SkillAwakened', { playerId: ownerId, skillId: QIANXIN }, { sourceId: ownerId })
  loseMaxHp(host as never, ownerId, 1, '潜心')
  if (playerOf(host.state, ownerId)?.alive) grantSkill(host.state, ownerId, JIANYAN)
} }] })

// 【荐言】：按类别或颜色逐张公开牌堆顶，直至命中；一名男性角色获得命中牌。
registerSkillRuntime({ id: JIANYAN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, JIANYAN) && state.zones.drawPile.length
      ? [{ id: `skill:${JIANYAN}`, label: '荐言：声明类别或颜色并按条件亮牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${JIANYAN}`) throw new Error('荐言动作不匹配')
    askOption(host, JIANYAN, ownerId, 'declare', '选择【荐言】寻找的牌类别或颜色', [
      { id: 'basic', label: '基本牌' }, { id: 'trick', label: '锦囊牌' }, { id: 'equipment', label: '装备牌' },
      { id: 'red', label: '红色牌' }, { id: 'black', label: '黑色牌' },
    ], {})
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'declare') {
      const declaration = (response.payload as any).optionId
      if (!['basic', 'trick', 'equipment', 'red', 'black'].includes(declaration)) return
      mark(host, `jianyan:${ownerId}`, { declaration, revealed: [] })
      markUsedThisPhase(host.state, ownerId, JIANYAN)
      if (playerOf(host.state, ownerId)?.characterId === 'jie-xushu-b64') {
        const matchedIndex = host.state.zones.drawPile.findIndex((cardId) => {
          const card = host.state.cards[cardId]
          return card && (['basic', 'trick', 'equipment'].includes(declaration)
            ? card.category === declaration
            : effectiveCardColor(host.state, ownerId, cardId) === declaration)
        })
        const cardId = matchedIndex >= 0 ? host.state.zones.drawPile[matchedIndex] : undefined
        if (!cardId) return
        moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
        host.dispatch('CardMove', { playerId: ownerId, cardIds: [cardId], reason: JIANYAN, revealed: true, revealedCardName: host.state.cards[cardId]?.name }, { sourceId: ownerId, cardIds: [cardId] })
        const maleIds = alive(host.state).filter(p => getCharacter(p.characterId ?? '')?.gender === 'male').map(p => p.id)
        if (maleIds.length) askTargets(host, JIANYAN, ownerId, 'recipient', maleIds, '【荐言】：选择一名男性角色获得此牌', { cardId, revealed: [cardId] })
        else settleJianyan(host, cardId, [cardId], null)
        return
      }
    }
    if (resolution.step === 'declare' || resolution.step === 'reveal-next') {
      const record = read(stateOf(host), `jianyan:${ownerId}`)
      if (!host.state.zones.drawPile.length) reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))
      const cardId = host.state.zones.drawPile[0]
      if (!cardId) {
        settleJianyan(host, null, record.revealed, null)
        return
      }
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
      record.revealed.push(cardId)
      const card = host.state.cards[cardId]
      host.dispatch('CardMove', { playerId: ownerId, cardIds: [cardId], reason: JIANYAN, revealed: true, revealedCardName: card.name }, { sourceId: ownerId, cardIds: [cardId] })
      const matched = ['basic', 'trick', 'equipment'].includes(record.declaration)
        ? card.category === record.declaration
        : effectiveCardColor(host.state, ownerId, cardId) === record.declaration
      if (!matched) { host.queueSkill({ skillId: JIANYAN, ownerId, step: 'reveal-next', data: {} }); return }
      mark(host, `jianyan:${ownerId}`, { ...record, matched: cardId })
      const maleIds = alive(host.state).filter(p => getCharacter(p.characterId ?? '')?.gender === 'male').map(p => p.id)
      if (maleIds.length) askTargets(host, JIANYAN, ownerId, 'recipient', maleIds, '【荐言】：选择一名男性角色获得最后亮出的牌', { cardId, revealed: record.revealed })
      else settleJianyan(host, cardId, record.revealed, null)
      return
    }
    if (resolution.step === 'recipient') {
      const [targetId] = (response.payload as any).targetIds as PlayerId[]
      const cardId = resolution.data.cardId as CardId
      const revealed = resolution.data.revealed as CardId[]
      const received = Boolean(playerOf(host.state, targetId)?.alive && host.state.zones.processingArea.includes(cardId))
      if (received) {
        moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId })
        host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: JIANYAN, revealed: true }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      }
      settleJianyan(host, cardId, revealed, received ? targetId : null)
    }
  },
})
function settleJianyan(host: SkillHost, matchedId: CardId | null, revealed: CardId[], recipientId: PlayerId | null) {
  for (const id of revealed) if ((id !== matchedId || !recipientId) && host.state.zones.processingArea.includes(id)) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'discardPile' })
}

// 其余技能运行时和角色册条目在本文件后续定义中实现。
const FENWEI = 'fenwei-jie-b39'
const QINXUE = 'qinxue-jie-b39'
const KANXIN = 'kanxin-jie-b39'
const KURUO = 'kurou-jie-b39'
const ZHAXIANG = 'zhaxiang-jie-b39'
const YINGZI = 'yingzi-jie-b39'
const FANJIAN = 'fanjian-jie-b39'
const GUOSE = 'guose-jie-b39'
const QIANXUN = 'qianxun-jie-b39'
const JIANXIONG = 'jianxiong-jie-b39'
const GUICAI = 'guicai-jie-b39'
const GANGLIE = 'ganglie-jie-b39'
const QINGJIAN = 'qingjian-jie-b39'

// 界甘宁【奋威】：在多目标锦囊开始结算前，选择任意目标令其无效；限定技一局一次。
registerSkillRuntime({ id: FENWEI, limited: true,
  interceptSourceTarget(host, ownerId, context) {
    const resolution = host.state.cardResolution as any
    const owner = playerOf(host.state, ownerId)
    if (context.category !== 'trick' || context.cardName === '闪电' || resolution?.sourceId !== ownerId
      || resolution.targetIds?.length < 2 || owner?.usedLimitedSkills.includes(FENWEI)) return false
    askOption(host, FENWEI, ownerId, 'invoke', '【奋威】：是否令此锦囊对任意名目标无效？', [
      { id: 'yes', label: '发动【奋威】' }, { id: 'no', label: '放弃' },
    ], { cardId: context.cardId, targetIds: [...resolution.targetIds] })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const cardResolution = host.state.cardResolution as any
    if (resolution.step === 'invoke') {
      if ((response.payload as any).optionId !== 'yes') { host.resumeCardTarget(); return }
      const owner = playerOf(host.state, ownerId)
      if (!owner || owner.usedLimitedSkills.includes(FENWEI)) { host.resumeCardTarget(); return }
      owner.usedLimitedSkills.push(FENWEI)
      askTargets(host, FENWEI, ownerId, 'targets', (resolution.data.targetIds as PlayerId[]).filter(id => playerOf(host.state, id)?.alive), '【奋威】：选择令此锦囊对哪些目标无效（可不选）', { cardId: resolution.data.cardId }, 0, (resolution.data.targetIds as PlayerId[]).length, true)
      return
    }
    if (resolution.step === 'targets') {
      if (cardResolution?.cardId === resolution.data.cardId) {
        cardResolution.nullifiedTargetIds ??= []
        for (const id of (response.payload as any).targetIds as PlayerId[]) if (cardResolution.targetIds.includes(id) && !cardResolution.nullifiedTargetIds.includes(id)) cardResolution.nullifiedTargetIds.push(id)
      }
      host.resumeCardTarget()
    }
  },
})

// 界吕蒙【勤学】觉醒后获得【攻心】。
registerSkillRuntime({ id: QINXUE, awakening: {
  phase: 'prepare',
  ready(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const threshold = state.players.filter(player => player.alive).length >= 7 ? 2 : 3
    return Boolean(owner && owner.zones.hand.length - owner.hp >= threshold)
  },
  invoke(host, ownerId) {
    loseMaxHp(host as never, ownerId, 1, '勤学')
    if (playerOf(host.state, ownerId)?.alive) grantSkill(host.state, ownerId, KANXIN)
  },
} })
registerSkillRuntime({ id: KANXIN,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, KANXIN) && others(state, ownerId).length
      ? [{ id: `skill:${KANXIN}`, label: '攻心：观看一名角色的手牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${KANXIN}`) throw new Error('攻心动作不匹配')
    askTargets(host, KANXIN, ownerId, 'target', others(host.state, ownerId).map(p => p.id), '【攻心】：选择一名其他角色')
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as any).targetIds as PlayerId[]
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      host.dispatch('CardMove', { playerId: targetId, cardIds: [...target.zones.hand], reason: KANXIN, revealed: true }, { sourceId: ownerId, targetId, cardIds: [...target.zones.hand] })
      const hearts = target.zones.hand.filter(id => effectiveCardSuit(host.state, targetId, id) === 'heart')
      askCards(host, KANXIN, ownerId, 'heart', hearts, '【攻心】：可展示并选择一张红桃牌弃置或置于牌堆顶', { targetId }, 0, 1, true)
      markUsedThisPhase(host.state, ownerId, KANXIN)
      return
    }
    if (resolution.step === 'heart') {
      const cardId = (response.payload as any).cardIds?.[0] as CardId | undefined
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!cardId || !target?.zones.hand.includes(cardId) || effectiveCardSuit(host.state, targetId, cardId) !== 'heart') return
      askOption(host, KANXIN, ownerId, 'place', '【攻心】：选择处理这张红桃牌的方式', [
        { id: 'discard', label: '弃置此牌' }, { id: 'top', label: '置于牌堆顶' },
      ], { targetId, cardId })
      return
    }
    const { targetId, cardId } = resolution.data as any
    const target = playerOf(host.state, targetId)
    if (!target?.zones.hand.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, (response.payload as any).optionId === 'top' ? { kind: 'drawPile' } : { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: KANXIN }, { sourceId: targetId, cardIds: [cardId] })
  },
})

// 界黄盖【苦肉】【诈降】：体力流失（非伤害）也触发诈降，红杀特权只持续至本回合结束。
registerSkillRuntime({ id: KURUO,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const cards = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter(Boolean)] : []
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, KURUO) && cards.length
      ? [{ id: `skill:${KURUO}`, label: '苦肉：弃置一张牌并失去1点体力' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${KURUO}`) throw new Error('苦肉动作不匹配')
    const owner = playerOf(host.state, ownerId)!
    const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter(Boolean)]
    askCards(host, KURUO, ownerId, 'cost', cards, '【苦肉】：弃置一张牌', {}, 1, 1)
  },
  resume(host, ownerId, _resolution, response) {
    const cardId = (response.payload as any).cardIds?.[0] as CardId
    const zone = locateOwnedCard(host.state, ownerId, cardId)
    if (!zone) return
    moveCard(host.state, cardId, zone, { kind: 'discardPile' })
    if (zone.kind === 'equipment') handleEquipmentLost(host as never, ownerId, cardId)
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: KURUO }, { sourceId: ownerId, cardIds: [cardId] })
    markUsedThisPhase(host.state, ownerId, KURUO)
    loseHp(host as never, ownerId, 1, KURUO)
  },
})
registerSkillRuntime({ id: ZHAXIANG,
  triggers: [{ event: 'LoseHp', handle(host, ownerId, context) {
    const event = context.event
    if (event.targetId !== ownerId) return
    const amount = Math.max(1, Number((event.payload as any).amount ?? 1))
    for (let index = 0; index < amount; index++) {
      draw(host, ownerId, 3, ZHAXIANG)
      if (host.state.currentPlayerId === ownerId && host.state.phase === 'play') {
        const marks = playerOf(host.state, ownerId)!.marks
        marks[ZHAXIANG] = host.state.turnNumber
        grantTurnSlashBonus(host.state, ownerId, { extraUses: 1 })
      }
    }
  } }],
  slashIgnoresDistance(state, ownerId, cardId) { return playerOf(state, ownerId)?.marks[ZHAXIANG] === state.turnNumber && Boolean(cardId && effectiveCardColor(state, ownerId, cardId) === 'red') },
  slashUndodgeable(state, ownerId, _targetId, cardId) { return playerOf(state, ownerId)?.marks[ZHAXIANG] === state.turnNumber && Boolean(cardId && effectiveCardColor(state, ownerId, cardId) === 'red') },
})

// 界周瑜【英姿】锁定额摸一并按体力上限计算手牌上限。
registerSkillRuntime({ id: YINGZI,
  fixedMaxCards(state, ownerId) { return playerOf(state, ownerId)?.maxHp ?? null },
  triggers: [{ event: 'DrawPhase', handle(_host, ownerId, context) {
    if ((context.event.payload as any).playerId === ownerId) (context.event.payload as any).count = Number((context.event.payload as any).count ?? 2) + 1
  } }],
})

// 界周瑜【反间】：明置交牌，由目标选择展示同花色牌弃置或失去体力。
registerSkillRuntime({ id: FANJIAN,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, FANJIAN) && hand(state, ownerId).length && others(state, ownerId).length
      ? [{ id: `skill:${FANJIAN}`, label: '反间：正面交给一名角色一张手牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${FANJIAN}`) throw new Error('反间动作不匹配')
    askCards(host, FANJIAN, ownerId, 'card', hand(host.state, ownerId), '【反间】：选择正面交给目标的手牌')
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'card') {
      const cardId = (response.payload as any).cardIds?.[0] as CardId
      if (!hand(host.state, ownerId).includes(cardId)) return
      askTargets(host, FANJIAN, ownerId, 'target', others(host.state, ownerId).map(p => p.id), '【反间】：选择获得牌并作出选择的角色', { cardId })
      return
    }
    if (resolution.step === 'target') {
      const cardId = resolution.data.cardId as CardId
      const [targetId] = (response.payload as any).targetIds as PlayerId[]
      if (!playerOf(host.state, targetId)?.alive || !hand(host.state, ownerId).includes(cardId)) return
      const suit = effectiveCardSuit(host.state, ownerId, cardId)
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: FANJIAN }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: FANJIAN, revealed: true }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      markUsedThisPhase(host.state, ownerId, FANJIAN)
      askOption(host, FANJIAN, ownerId, 'choice', '【反间】：选择展示手牌并弃置与交给你的牌花色相同的所有牌，或失去1点体力', [
        { id: 'discard-suit', label: '展示手牌并弃置同花色牌' }, { id: 'lose-hp', label: '失去1点体力' },
      ], { targetId, suit }, false, targetId)
      return
    }
    const { targetId, suit } = resolution.data as any
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    if ((response.payload as any).optionId === 'lose-hp') { loseHp(host as never, targetId, 1, FANJIAN); return }
    host.dispatch('CardMove', { playerId: targetId, cardIds: [...target.zones.hand], reason: FANJIAN, revealed: true }, { sourceId: targetId, targetId, cardIds: [...target.zones.hand] })
    const matching = target.zones.hand.filter(id => effectiveCardSuit(host.state, targetId, id) === suit)
    discardHand(host, targetId, matching, FANJIAN)
  },
})

// 界大乔【国色】：方块转乐不思蜀或弃方块移除场上乐不思蜀，之后摸一张；两项共用每回合一次。
registerSkillRuntime({ id: GUOSE,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as any
      const cardId = payload.cardId as CardId | undefined
      const key = `guose-conversion:${ownerId}:${cardId}`
      if (context.event.sourceId === ownerId && cardId && read(stateOf(host), key)
        && payload.cardName !== '乐不思蜀') mark(host, key, false)
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const payload = context.event.payload as any
      const cardId = payload.cardId as CardId | undefined
      const key = `guose-conversion:${ownerId}:${cardId}`
      if (!cardId || context.event.sourceId !== ownerId || payload.cardName !== '乐不思蜀' || !read(stateOf(host), key)) return
      mark(host, key, false)
      if (playerOf(host.state, ownerId)?.alive) draw(host, ownerId, 1, GUOSE)
    } },
  ],
  viewAs(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, GUOSE)) return []
    return hand(state, ownerId).filter(id => effectiveCardSuit(state, ownerId, id) === 'diamond' && state.cards[id]?.name !== '乐不思蜀')
      .map(cardId => ({ asCardName: '乐不思蜀', cardId, label: `将【${state.cards[cardId].name}】当【乐不思蜀】使用（国色）` }))
  },
  interceptPlayAction(host, ownerId, action) {
    if (action.asCardName !== '乐不思蜀' || !action.cardIds?.length || host.state.currentPlayerId !== ownerId) return false
    const cardId = action.cardIds[0]
    if (host.state.cards[cardId]?.name === '乐不思蜀' || effectiveCardSuit(host.state, ownerId, cardId) !== 'diamond' || usedThisPhase(host.state, ownerId, GUOSE)) return false
    markUsedThisPhase(host.state, ownerId, GUOSE)
    mark(host, `guose-conversion:${ownerId}:${cardId}`, true)
    return false
  },
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const removable = state.players.some(player => player.alive && player.zones.judgingArea.some(id => state.cards[id]?.name === '乐不思蜀'))
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, GUOSE)
      && hand(state, ownerId).some(id => effectiveCardSuit(state, ownerId, id) === 'diamond') && removable
      ? [{ id: `skill:${GUOSE}:remove`, label: '国色：弃置方块牌并移除场上的【乐不思蜀】' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${GUOSE}:remove`) throw new Error('国色动作不匹配')
    const diamonds = hand(host.state, ownerId).filter(id => effectiveCardSuit(host.state, ownerId, id) === 'diamond')
    const delayed = host.state.players.filter(p => p.alive).flatMap(p => p.zones.judgingArea.filter(id => host.state.cards[id]?.name === '乐不思蜀').map(cardId => ({ playerId: p.id, cardId })))
    askCards(host, GUOSE, ownerId, 'cost', diamonds, '【国色】：选择一张方块牌弃置', { delayed }, 1, 1)
  },
  resume(host, ownerId, resolution, response) {
    const [cost] = (response.payload as any).cardIds as CardId[]
    if (!hand(host.state, ownerId).includes(cost) || effectiveCardSuit(host.state, ownerId, cost) !== 'diamond') return
    const delayed = (resolution.data.delayed as Array<{ playerId: PlayerId; cardId: CardId }>).find(item => playerOf(host.state, item.playerId)?.zones.judgingArea.includes(item.cardId))
    if (!delayed) return
    discardHand(host, ownerId, [cost], GUOSE)
    moveCard(host.state, delayed.cardId, { kind: 'judgingArea', playerId: delayed.playerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: delayed.playerId, cardIds: [delayed.cardId], reason: GUOSE }, { targetId: delayed.playerId, cardIds: [delayed.cardId] })
    markUsedThisPhase(host.state, ownerId, GUOSE)
    draw(host, ownerId, 1, GUOSE)
  },
})

// 界陆逊【谦逊】：唯一目标的相应锦囊生效前暂存全手牌，当前回合结束时收回。
const QIANXUN_PILE = 'qianxun-jie-b39'
registerSkillRuntime({ id: QIANXUN,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
    const payload = context.event.payload as any
    const targets = payload.targetIds as PlayerId[] | undefined
    if (!['乐不思蜀', '兵粮寸断', '闪电'].includes(payload.cardName)
      || context.event.sourceId === ownerId || targets?.length !== 1 || targets[0] !== ownerId) return
    if (!hand(host.state, ownerId).length || read(stateOf(host), `qianxun-turn:${ownerId}`) === host.state.turnNumber) return
    host.queueSkill({ skillId: QIANXUN, ownerId, step: 'delayed-ask', data: { cardName: payload.cardName } })
    } },
    { event: 'TurnEnd', handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner || read(stateOf(host), `qianxun-turn:${ownerId}`) !== host.state.turnNumber) return
      for (const cardId of [...(owner.characterPiles[QIANXUN_PILE] ?? [])]) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: QIANXUN_PILE }, { kind: 'hand', playerId: ownerId })
      owner.hiddenCharacterPiles = (owner.hiddenCharacterPiles ?? []).filter(pile => pile !== QIANXUN_PILE)
      mark(host, `qianxun-turn:${ownerId}`, null)
    } },
  ],
  interceptTarget(host, ownerId, context) {
    if (context.targetId !== ownerId || context.sourceId === ownerId || context.category !== 'trick') return false
    const resolution = host.state.cardResolution as any
    const delayed = ['乐不思蜀', '兵粮寸断', '闪电'].includes(context.cardName)
    if ((!delayed && !resolution?.targetIds?.includes(ownerId)) || resolution?.targetIds?.length !== 1) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.zones.hand.length || read(stateOf(host), `qianxun-turn:${ownerId}`) === host.state.turnNumber) return false
    askOption(host, QIANXUN, ownerId, 'invoke', '是否发动【谦逊】将所有手牌扣置，回合结束时收回？', [
      { id: 'yes', label: '扣置所有手牌' }, { id: 'no', label: '不发动' },
    ], { cardId: context.cardId })
    return true
  },
  resume(host, ownerId, _resolution, response) {
    if ((response.payload as any).optionId === 'yes') {
      const owner = playerOf(host.state, ownerId)!
      mark(host, `qianxun-turn:${ownerId}`, host.state.turnNumber)
      owner.hiddenCharacterPiles ??= []
      if (!owner.hiddenCharacterPiles.includes(QIANXUN_PILE)) owner.hiddenCharacterPiles.push(QIANXUN_PILE)
      for (const cardId of [...owner.zones.hand]) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: QIANXUN_PILE })
    }
    if (_resolution.data.delayed !== true) host.resumeCardTarget()
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'delayed-ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !owner.zones.hand.length || read(stateOf(host), `qianxun-turn:${ownerId}`) === host.state.turnNumber) return
    askOption(host, QIANXUN, ownerId, 'invoke', '是否发动【谦逊】将所有手牌扣置，当前回合结束时收回？', [
      { id: 'yes', label: '扣置所有手牌' }, { id: 'no', label: '不发动' },
    ], { delayed: true, cardName: prompt.data.cardName })
  },
})

// 界曹操【奸雄】：获得伤害牌后额外摸一张。
registerSkillRuntime({ id: JIANXIONG,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId) return
    host.queueSkill({ skillId: JIANXIONG, ownerId, step: 'ask', data: { cardId: (context.event.payload as any).cardId ?? null } })
  } }],
  startQueued(host, ownerId, prompt) {
    const cardId = prompt.data.cardId as CardId | null
    if (!cardId || !host.state.zones.discardPile.includes(cardId)) return
    askOption(host, JIANXIONG, ownerId, 'invoke', `是否发动【奸雄】获得伤害牌并摸一张牌？`, [{ id: 'yes', label: '获得并摸牌' }, { id: 'no', label: '放弃' }], { cardId })
  },
  resume(host, ownerId, resolution, response) {
    if ((response.payload as any).optionId !== 'yes') return
    const cardId = resolution.data.cardId as CardId
    if (host.state.zones.discardPile.includes(cardId) && playerOf(host.state, ownerId)?.alive) {
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: JIANXIONG }, { targetId: ownerId, cardIds: [cardId] })
    }
    if (playerOf(host.state, ownerId)?.alive) draw(host, ownerId, 1, JIANXIONG)
  },
})

// 界司马懿【鬼才】可用手牌或装备区任意牌改判；改判引擎统一处理装备离场。
registerSkillRuntime({ id: GUICAI,
  retrial(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
  },
})

// 界夏侯惇【刚烈】：逐点判定；红色伤来源受1伤，黑色则弃其一张牌。
const GANGLIE_TAG = 'ganglie-jie-b39'
registerJudgmentContinuation(GANGLIE_TAG, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const sourceId = data.sourceId as PlayerId
  const source = playerOf(host.state, sourceId)
  if (!source?.alive) return
  if (judged.color === 'red') { resolveDamage(host as never, { sourceId: ownerId, targetId: sourceId, amount: 1, nature: 'normal', cardName: '刚烈' }); return }
  const equipment = Object.values(source.zones.equipment).filter((id): id is CardId => Boolean(id))
  const handCards = [...source.zones.hand]
  const cardIds = [...handCards, ...equipment]
  if (!cardIds.length) return
  host.askSkill({ skillId: GANGLIE, ownerId, step: 'discard', data: { sourceId }, build: id => ({
    id, kind: 'choose-cards', playerId: sourceId, prompt: '【刚烈】：选择弃置你的一张手牌或装备牌', timeoutMs: 25_000, optional: false,
    purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
  }) })
})
registerSkillRuntime({ id: GANGLIE,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId) return
    const sourceId = context.event.sourceId
    if (!sourceId) return
    for (let index = 0; index < Math.max(1, Number((context.event.payload as any).amount ?? 1)); index++) host.queueSkill({ skillId: GANGLIE, ownerId, step: 'ask', data: { sourceId } })
  } }],
  startQueued(host, ownerId, prompt) {
    const sourceId = prompt.data.sourceId as PlayerId
    if (!playerOf(host.state, sourceId)?.alive) return
    askOption(host, GANGLIE, ownerId, 'invoke', '是否发动【刚烈】进行判定？', [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }], { sourceId })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as any).optionId === 'yes') performJudgment(host as never, ownerId, '刚烈', { tag: GANGLIE_TAG, data: { ownerId, sourceId: resolution.data.sourceId } })
      return
    }
    const sourceId = resolution.data.sourceId as PlayerId
    const [picked] = (response.payload as any).cardIds as string[]
    if (!picked) return
    if (playerOf(host.state, sourceId)?.zones.hand.includes(picked as CardId)) {
      discardHand(host, sourceId, [picked as CardId], GANGLIE)
      return
    }
    const source = playerOf(host.state, sourceId)
    if (!source?.alive) return
    const slot = (Object.keys(source.zones.equipment) as Array<keyof typeof source.zones.equipment>).find(key => source.zones.equipment[key] === picked)
    if (slot) {
      moveCard(host.state, picked, { kind: 'equipment', playerId: sourceId, slot }, { kind: 'discardPile' })
      handleEquipmentLost(host as never, sourceId, picked)
      host.dispatch('LoseEquipment', { playerId: sourceId, cardIds: [picked], reason: GANGLIE }, { sourceId: sourceId, cardIds: [picked] })
    }
  },
})

// 界夏侯惇【清俭】：摸牌阶段外可将本次获得的牌中的任意张扣置；角色回合结束时分给其他人。
const QINGJIAN_PILE = 'qingjian-jie-b39'
registerSkillRuntime({ id: QINGJIAN,
  triggers: [
    { event: 'GainCard', handle(host, ownerId, context) {
      const payload = context.event.payload as any
      if (payload.playerId !== ownerId || host.state.phase === 'draw') return
      const gained = (payload.cardIds as CardId[] | undefined)?.filter(id => hand(host.state, ownerId).includes(id)) ?? []
      if (gained.length) host.queueSkill({ skillId: QINGJIAN, ownerId, step: 'collect', data: { cardIds: gained } })
    } },
    { event: 'TurnEnd', handle(host, ownerId) {
      const pile = playerOf(host.state, ownerId)?.characterPiles[QINGJIAN_PILE] ?? []
      if (pile.length) host.queueSkill({ skillId: QINGJIAN, ownerId, step: 'distribute', data: { cardIds: [...pile] } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'collect') {
      const valid = (prompt.data.cardIds as CardId[]).filter(id => hand(host.state, ownerId).includes(id))
      if (valid.length) askCards(host, QINGJIAN, ownerId, 'collect', valid, '【清俭】：可将本次获得的任意张牌扣置于武将牌上', {}, 0, valid.length, true)
      return
    }
    const pile = (prompt.data.cardIds as CardId[]).filter(id => playerOf(host.state, ownerId)?.characterPiles[QINGJIAN_PILE]?.includes(id))
    const recipientIds = others(host.state, ownerId).map(player => player.id)
    if (!pile.length || !recipientIds.length) return
    host.askSkill({ skillId: QINGJIAN, ownerId, step: 'distribute', data: { cardIds: pile }, build: id => ({
      id, kind: 'distribute-cards', playerId: ownerId, prompt: '【清俭】：将武将牌上的牌交给其他角色', timeoutMs: 25_000,
      optional: false, cardIds: pile, recipientIds, min: pile.length, max: pile.length,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'collect') {
      const ids = (response.payload as any).cardIds as CardId[]
      const stored = ids.filter(id => hand(host.state, ownerId).includes(id))
      for (const id of stored) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: QINGJIAN_PILE })
      if (stored.length) {
        const owner = playerOf(host.state, ownerId)!
        owner.hiddenCharacterPiles ??= []
        if (!owner.hiddenCharacterPiles.includes(QINGJIAN_PILE)) owner.hiddenCharacterPiles.push(QINGJIAN_PILE)
      }
      return
    }
    const assignments = (response.payload as any).assignments as Array<{ cardId: CardId; recipientId: PlayerId }>
    for (const item of assignments) {
      if (!playerOf(host.state, ownerId)?.characterPiles[QINGJIAN_PILE]?.includes(item.cardId) || !playerOf(host.state, item.recipientId)?.alive) continue
      moveCard(host.state, item.cardId, { kind: 'characterPile', playerId: ownerId, pile: QINGJIAN_PILE }, { kind: 'hand', playerId: item.recipientId })
      host.dispatch('GainCard', { playerId: item.recipientId, cardIds: [item.cardId], reason: QINGJIAN }, { sourceId: ownerId, targetId: item.recipientId, cardIds: [item.cardId] })
    }
    if (!(playerOf(host.state, ownerId)?.characterPiles[QINGJIAN_PILE]?.length)) {
      const owner = playerOf(host.state, ownerId)
      if (owner) owner.hiddenCharacterPiles = (owner.hiddenCharacterPiles ?? []).filter(pile => pile !== QINGJIAN_PILE)
    }
  },
})

export const HISTORICAL_BATCH37_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'sp-xushu-b39', name: 'SP·徐庶', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: ZHUHAI, name: '诛害', description: '其他角色的结束阶段，若该角色于此回合内造成过伤害，则你可以对其使用一张【杀】。' },
    { id: QIANXIN, name: '潜心', description: '觉醒技，当你造成伤害后，若你已受伤，你减1点体力上限，然后获得“荐言”。' },
    { id: JIANYAN, name: '荐言', granted: true, description: '出牌阶段限一次，你可以选择一种牌的类别或颜色，然后亮出牌堆顶的一张牌，若此牌不为此类别或颜色，你重复此流程。你令一名男性角色获得最后亮出的牌，然后将其余亮出的牌置入弃牌堆。' },
  ] },
  { id: 'jie-ganning-b39', name: '界·甘宁', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: 'qixi', name: '奇袭', description: '你可以将一张黑色牌当【过河拆桥】使用。' },
    { id: FENWEI, name: '奋威', description: '限定技，当一张锦囊牌指定两个或更多目标后，你可令此牌对其中任意名目标角色无效。' },
  ] },
  { id: 'jie-lvmeng-b39', name: '界·吕蒙', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: 'keji', name: '克己', description: '若你未于出牌阶段内使用或打出过【杀】，则你可以跳过弃牌阶段。' },
    { id: QINXUE, name: '勤学', description: '觉醒技，准备阶段，若你的手牌数比你的体力值多3或更多（若游戏人数不小于7则改为2），你减1点体力上限，然后获得“攻心”。' },
    { id: KANXIN, name: '攻心', granted: true, description: '出牌阶段限一次，你可以观看一名其他角色的手牌，然后你可以展示其中一张红桃牌，选择一项：弃置此牌或将此牌置于牌堆顶。' },
  ] },
  { id: 'jie-huanggai-b39', name: '界·黄盖', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: KURUO, name: '苦肉', description: '出牌阶段限一次，你可以弃置一张牌，然后失去1点体力。' },
    { id: ZHAXIANG, name: '诈降', locked: true, description: '锁定技，当你失去1点体力后，你摸三张牌，然后若此时在你的出牌阶段内，则直到回合结束，你使用红色【杀】无距离限制且不能被【闪】响应，且你可以多使用一张【杀】。' },
  ] },
  { id: 'jie-zhouyu-b39', name: '界·周瑜', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: YINGZI, name: '英姿', locked: true, description: '锁定技，摸牌阶段，你多摸一张牌；你的手牌上限等于你的体力上限。' },
    { id: FANJIAN, name: '反间', description: '出牌阶段限一次，你可以将一张手牌正面向上交给一名其他角色，该角色选择一项：展示所有手牌，然后弃置与此牌花色相同的所有牌，或失去1点体力。' },
  ] },
  { id: 'jie-daqiao-b39', name: '界·大乔', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: GUOSE, name: '国色', description: '出牌阶段限一次，你可以将一张方块牌当【乐不思蜀】使用，或弃置一张方块牌并弃置场上的一张【乐不思蜀】。选择完成后，你摸一张牌。' },
    { id: 'liuli', name: '流离', qiexie: true, description: '当你成为【杀】的目标时，你可以弃置一张牌并选择你攻击范围内的一名其他角色，然后将此【杀】转移给该角色。' },
  ] },
  { id: 'jie-luxun-b39', name: '界·陆逊', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: QIANXUN, name: '谦逊', description: '当一张延时锦囊牌或其他角色使用的普通锦囊牌对你生效时，若你是此牌唯一目标，则你可以将所有手牌扣置于武将牌上，然后此回合结束时，你获得这些牌。' },
    { id: 'lianying', name: '连营', description: '当你失去手牌后，若你没有手牌，则你可以令至多X名角色各摸一张牌（X为你此次失去的手牌数）。' },
  ] },
  { id: 'jie-caocao-b39', name: '界·曹操', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: JIANXIONG, name: '奸雄', description: '当你受到伤害后，你可以获得对你造成伤害的牌并摸一张牌。' },
    { id: 'hujia', name: '护驾', description: '主公技，当你需要使用或打出【闪】时，你可以令其他魏势力角色选择是否打出一张【闪】（视为由你使用或打出）。' },
  ] },
  { id: 'jie-simayi-b39', name: '界·司马懿', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: 'fankui', name: '反馈', description: '当你受到1点伤害后，你可以获得伤害来源的一张牌。' },
    { id: GUICAI, name: '鬼才', description: '当一名角色的判定牌生效前，你可以打出一张牌代替之。' },
  ] },
  { id: 'jie-xiahou-dun-b39', name: '界·夏侯惇', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: GANGLIE, name: '刚烈', description: '当你受到1点伤害后，你可以进行判定，若结果为红色，你对伤害来源造成1点伤害；若为黑色，你弃置其一张牌。' },
    { id: QINGJIAN, name: '清俭', description: '当你于摸牌阶段外获得牌后，你可将其中任意张牌扣置于武将牌上；一名角色的回合结束后，你将这些牌交给其他角色。' },
  ] },
]
