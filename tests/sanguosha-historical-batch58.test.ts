import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter } from '@/sanguosha/data/characters/standard'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime, isCardResponseProhibited, isResponseCardProhibited } from '@/sanguosha/engine/skills/runtime'
import { queueExtraPhaseAfterCurrent } from '@/sanguosha/engine/extra-phase'
import { advancePhase } from '@/sanguosha/engine/turn'
import { moveCard } from '@/sanguosha/engine/zones'
import { discardCardsByIds } from '@/sanguosha/engine/discard-all'

const DANGSHI = 'dangshi-ji-zhangliao:b58'
const ZHENWEI = 'zhenwei-mou-zhuran:b58'
const HEYUAN = 'heyuan-mou-zhuran:b58'
const QIAOBIAN = 'qiaobian-mou-zhanghe:b58'
const LIAOSHI = 'liaoshi-mou-zhanghe:b58'
const XIANJIAN = 'xianjian-ji-lejin:b58'
const ZHERUI = 'zherui-ji-lejin:b58'

describe('第58批武将注册与荡势交互', () => {
  it('第58批保留九名武将均注册且每个技能有运行时', () => {
    const expected: Array<[string, string]> = [
      ['zhangji-b58', '张既'], ['ji-zhangliao-b58', '骥·张辽'], ['ji-lidian-b58', '骥·李典'],
      ['ji-lejin-b58', '骥·乐进'], ['xing-fazheng-b58', '星·法正'], ['yangqiu-b58', '阳球'],
      ['mou-zhuran-b58', '谋·朱然'], ['mou-zhanghe-b58', '谋·张郃'],
      ['mou-tianyu-b58', '谋·田豫'],
    ]
    for (const [id, name] of expected) {
      const character = getCharacter(id)
      expect(character?.name).toBe(name)
      for (const skill of character?.skills ?? []) expect(getSkillRuntime(skill.id), `${name}【${skill.name}】缺少运行时`).toBeDefined()
    }
    expect(getSkillRuntime(DANGSHI)).toBeDefined()
  })

  it('荡势独立接收结算后的触发，目标选择伤害时落实1点伤害', () => {
    const game = new SanguoshaGame({ seed: 'batch58-dangshi', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `b58p${index}`, nickname: `玩家${index}`, isHuman: true })),
    } })
    const [owner, target] = game.state.players
    if (!owner || !target) throw new Error('fixture players missing')
    owner.characterId = 'ji-zhangliao-b58'
    game.state.status = 'playing'
    const before = target.hp
    const runtime = getSkillRuntime(DANGSHI)
    runtime?.startQueued?.(game as never, owner.id, {
      skillId: DANGSHI, ownerId: owner.id, step: 'target',
      data: { targetIds: [target.id], cardId: 'fixture-slash', cardName: '杀' },
    })
    const chooseTarget = game.state.pendingRequests.at(-1)
    expect(chooseTarget?.kind).toBe('choose-targets')
    if (!chooseTarget) throw new Error('荡势没有发出目标请求')
    game.respond({ requestId: chooseTarget.id, playerId: owner.id, payload: { targetIds: [target.id] } })

    const chooseEffect = game.state.pendingRequests.at(-1)
    expect(chooseEffect?.kind).toBe('choose-option')
    if (!chooseEffect) throw new Error('荡势没有发出目标选项请求')
    game.respond({ requestId: chooseEffect.id, playerId: target.id, payload: { optionId: 'damage' } })
    expect(target.hp).toBe(before - 1)
  })

  it('镇围双方同时秘密提交，收齐后再结算至多两项效果', () => {
    const game = new SanguoshaGame({ seed: 'batch58-zhenwei', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `zhenwei${index}`, nickname: `玩家${index}`, isHuman: true })),
    } })
    const [owner, target] = game.state.players
    if (!owner || !target) throw new Error('fixture players missing')
    owner.characterId = 'mou-zhuran-b58'
    game.state.status = 'playing'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const runtime = getSkillRuntime(ZHENWEI)!
    runtime.invokeActive?.(game as never, owner.id)
    const targetRequest = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [target.id] } })
    const group = game.state.groupCardDecision!
    expect(group).toBeDefined()
    expect(Object.keys(group.requestIds)).toHaveLength(2)
    const firstRequest = game.state.pendingRequests.find((request) => request.id === group.requestIds[owner.id])!
    const secondRequest = game.state.pendingRequests.find((request) => request.id === group.requestIds[target.id])!
    game.respond({ requestId: firstRequest.id, playerId: owner.id, payload: { cardIds: [] } })
    expect(game.state.groupCardDecision).toBeDefined()
    expect(game.state.pendingRequests.some((request) => request.id === secondRequest.id)).toBe(true)
    const before = target.hp
    const handBefore = owner.zones.hand.length
    game.respond({ requestId: secondRequest.id, playerId: target.id, payload: { cardIds: [] } })
    const effects = game.state.pendingRequests.at(-1)!
    expect(effects.kind).toBe('choose-options')
    game.respond({ requestId: effects.id, playerId: owner.id, payload: { optionIds: ['damage', 'draw'] } })
    expect(target.hp).toBe(before - 1)
    expect(owner.zones.hand.length).toBe(handBefore + 3)
  })

  it('料势只开放巧变所得实体手牌的杀/闪转化，并在该牌成功使用后关闭本回合额度', () => {
    const game = new SanguoshaGame({ seed: 'batch58-liaoshi', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `liaoshi${index}`, nickname: `玩家${index}`, isHuman: true })),
    } })
    const owner = game.state.players[0]!
    const cardId = game.state.zones.drawPile[0]!
    owner.characterId = 'mou-zhanghe-b58'
    owner.zones.hand.push(cardId)
    game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
    ;(game.state as typeof game.state & { b58ZhangHe: Record<string, unknown> }).b58ZhangHe = {
      [owner.id]: { turnNumber: game.state.turnNumber, skipped: [], acquiredCardIds: [cardId], usedAsBasic: false },
    }
    const runtime = getSkillRuntime(LIAOSHI)!
    expect(runtime.viewAs?.(game.state, owner.id).filter(({ cardId: id }) => id === cardId).map(({ asCardName }) => asCardName)).toEqual(['杀', '闪'])
    runtime.triggers?.find(({ event }) => event === 'CardUsed')?.handle(game as never, owner.id, {
      event: { id: 'batch58-liaoshi-use', seq: 1, name: 'CardUsed', payload: { cardId, cardName: '杀' }, sourceId: owner.id },
      cancelled: false, cancel() {},
    } as never)
    expect(runtime.viewAs?.(game.state, owner.id)).toEqual([])
    expect(getSkillRuntime(QIAOBIAN)).toBeDefined()
  })

  it('额外出牌阶段插在结束阶段后，结束后仍回到原结束阶段位', () => {
    const game = new SanguoshaGame({ seed: 'batch58-extra-phase', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `extraphase${index}`, nickname: `玩家${index}`, isHuman: true })),
    } })
    game.state.status = 'playing'
    game.state.phase = 'finish'
    const ownerId = game.state.currentPlayerId
    queueExtraPhaseAfterCurrent(game.state, ownerId, 'play', QIAOBIAN, 'finish')
    expect(advancePhase(game.state, (name, payload) => { game.dispatch(name, payload) })).toBe(true)
    expect(game.state.phase).toBe('play')
    expect(game.state.extraPhase?.skillId).toBe(QIAOBIAN)
    expect(advancePhase(game.state, (name, payload) => { game.dispatch(name, payload) })).toBe(true)
    expect(game.state.phase).toBe('finish')
    expect(game.state.extraPhase).toBeUndefined()
  })

  it('合援按上次弃牌数支付，受援角色执行上次镇围的最后一项且记为已协助', () => {
    const game = new SanguoshaGame({ seed: 'batch58-heyuan', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `heyuan${index}`, nickname: `玩家${index}`, isHuman: true })),
    } })
    const [owner, helper] = game.state.players
    if (!owner || !helper) throw new Error('fixture players missing')
    owner.characterId = 'mou-zhuran-b58'
    helper.hp -= 1
    game.state.status = 'playing'
    const paymentCard = game.state.zones.drawPile[0]!
    moveCard(game.state, paymentCard, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const state = game.state as typeof game.state & { b58ZhuRan: Record<string, { lastDiscardCount: number; lastEffect: 'draw'; lastTargetId: string; assisted?: Record<string, boolean> }> }
    state.b58ZhuRan = { [owner.id]: { lastDiscardCount: 1, lastEffect: 'draw', lastTargetId: helper.id } }
    const runtime = getSkillRuntime(HEYUAN)!
    const phaseStart = runtime.triggers?.find(({ event }) => event === 'PhaseStart')!
    phaseStart.handle(game as never, owner.id, {
      event: { id: 'batch58-heyuan-finish', seq: 1, name: 'PhaseStart', payload: { playerId: owner.id, phase: 'finish' } },
      cancelled: false, cancel() {},
    } as never)
    const targetRequest = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [helper.id] } })
    const costRequest = game.state.pendingRequests.at(-1)!
    const paid = owner.zones.hand[0]!
    const before = helper.zones.hand.length
    game.respond({ requestId: costRequest.id, playerId: owner.id, payload: { cardIds: [paid] } })
    expect(helper.zones.hand.length).toBe(before + 3)
    expect(state.b58ZhuRan[owner.id]?.aidedTargetId).toBe(helper.id)
    expect(state.b58ZhuRan[owner.id]?.assisted?.[helper.id]).toBe(true)
  })

  it('冲垒限制的是其他角色的非基本响应牌，不会误封张辽自己的响应', () => {
    const game = new SanguoshaGame({ seed: 'batch58-chonglei-response', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `chonglei${index}`, nickname: `玩家${index}`, isHuman: true })),
    } })
    const [owner, other] = game.state.players
    if (!owner || !other) throw new Error('fixture players missing')
    owner.characterId = 'ji-zhangliao-b58'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const basicSlash = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.name === '杀')!
    const trick = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.category === 'trick')!
    other.zones.hand.push(basicSlash, trick)
    game.state.zones.drawPile = game.state.zones.drawPile.filter((cardId) => cardId !== basicSlash && cardId !== trick)
    expect(isCardResponseProhibited(game.state, owner.id, '杀')).toBe(false)
    expect(isResponseCardProhibited(game.state, other.id, basicSlash, '杀')).toBe(false)
    expect(isResponseCardProhibited(game.state, other.id, trick, '杀')).toBe(true)
    expect(isResponseCardProhibited(game.state, other.id, trick, '闪')).toBe(false)
  })

  it('陷坚先正常结算杀，再把该实体杀放入所选空装备栏；失去时造成伤害并还原牌张', () => {
    const game = new SanguoshaGame({ seed: 'batch58-xianjian-trap-lifecycle', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `xianjian${index}`, nickname: `玩家${index}`, isHuman: true })),
    } })
    const [owner, target] = game.state.players
    if (!owner || !target) throw new Error('fixture players missing')
    owner.characterId = 'ji-lejin-b58'
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const action = game.legalActions(owner.id).find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes(target.id))
    if (!action || action.kind !== 'use-card') throw new Error('未生成对目标使用【杀】的动作')
    game.act(owner.id, action.id)
    const effect = game.state.pendingRequests.at(-1)
    expect(effect?.kind).toBe('choose-option')
    if (effect?.kind !== 'choose-option') throw new Error('陷坚未询问效果')
    game.respond({ requestId: effect.id, playerId: owner.id, payload: { optionId: 'trap' } })
    const dodge = game.state.pendingRequests.at(-1)
    if (dodge?.kind === 'respond-card') game.respond({ requestId: dodge.id, playerId: target.id, payload: { actionId: 'respond-pass' } })
    const slotRequest = game.state.pendingRequests.at(-1)
    expect(slotRequest?.kind).toBe('choose-option')
    if (slotRequest?.kind !== 'choose-option') throw new Error('杀结算后没有装备栏选择')
    game.respond({ requestId: slotRequest.id, playerId: owner.id, payload: { optionId: 'weapon' } })
    expect(target.zones.equipment.weapon).toBe(slash)
    expect(game.state.cards[slash]).toMatchObject({ name: '陷坚', category: 'equipment', equipmentSlot: 'weapon' })
    const hp = target.hp
    discardCardsByIds(game as never, target.id, [slash], '定向测试')
    expect(target.hp).toBe(hp - 1)
    expect(target.zones.equipment.weapon).toBeNull()
    expect(game.state.cards[slash]).toMatchObject({ name: '杀', category: 'basic' })
    expect(game.state.cards[slash]?.equipmentSlot).toBeUndefined()
  })

  it('折锐由持有陷坚牌者选择效果，弃牌分支正确由乐进摸牌并令其弃牌', () => {
    const game = new SanguoshaGame({ seed: 'batch58-zherui-discard', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `zherui${index}`, nickname: `玩家${index}`, isHuman: true })),
    } })
    const [lejin, attacker, victim] = game.state.players
    if (!lejin || !attacker || !victim) throw new Error('fixture players missing')
    lejin.characterId = 'ji-lejin-b58'
    attacker.characterId = 'ji-zhangliao-b58'
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = attacker.id
    const trap = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀' && id !== trap)!
    const discardable = game.state.zones.drawPile.find((id) => id !== trap && id !== slash)!
    const original = structuredClone(game.state.cards[trap]!)
    moveCard(game.state, trap, { kind: 'drawPile' }, { kind: 'equipment', playerId: attacker.id, slot: 'weapon' })
    game.state.cards[trap] = { ...original, name: '陷坚', category: 'equipment', equipmentSlot: 'weapon' }
    ;(game.state as typeof game.state & { b58LejinTraps: Record<string, { ownerId: string; targetId: string; originalCard: typeof original }> }).b58LejinTraps = {
      [trap]: { ownerId: lejin.id, targetId: attacker.id, originalCard: original },
    }
    moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: attacker.id })
    moveCard(game.state, discardable, { kind: 'drawPile' }, { kind: 'hand', playerId: attacker.id })
    const beforeLejin = lejin.zones.hand.length
    const action = game.legalActions(attacker.id).find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes(victim.id))
    if (!action || action.kind !== 'use-card') throw new Error('未生成持陷坚者的杀动作')
    game.act(attacker.id, action.id)
    const invoke = game.state.pendingRequests.at(-1)!
    expect(invoke).toMatchObject({ kind: 'choose-option', playerId: lejin.id })
    game.respond({ requestId: invoke.id, playerId: lejin.id, payload: { optionId: 'yes' } })
    const chooseEffect = game.state.pendingRequests.at(-1)!
    expect(chooseEffect).toMatchObject({ kind: 'choose-option', playerId: attacker.id })
    game.respond({ requestId: chooseEffect.id, playerId: attacker.id, payload: { optionId: 'discard' } })
    expect(lejin.zones.hand.length).toBe(beforeLejin + 1)
    const discard = game.state.pendingRequests.at(-1)!
    expect(discard).toMatchObject({ kind: 'choose-cards', playerId: attacker.id, min: 2, max: 2 })
    if (discard.kind !== 'choose-cards') throw new Error('折锐弃牌分支未请求弃牌')
    const hpBeforeTrapLoss = attacker.hp
    const handSlot = discard.hiddenCardSlots[0]
    if (!handSlot) throw new Error('折锐弃牌请求缺少手牌槽')
    game.respond({ requestId: discard.id, playerId: attacker.id, payload: { cardIds: [trap, handSlot] } })
    expect(game.state.zones.discardPile).toContain(discardable)
    expect(attacker.hp).toBe(hpBeforeTrapLoss - 1)
    expect(game.state.cards[trap]).toMatchObject({ name: '杀', category: 'basic' })
  })

  it('国战于禁及专属节钺已移除，其他于禁版本保留', () => {
    expect(getCharacter('guozhan-yujin-b58')).toBeUndefined()
    expect(ALL_CHARACTERS.some((character) => character.name === '国战·于禁')).toBe(false)
    expect(getSkillRuntime('jieyue-guozhan-yujin:b58')).toBeUndefined()
    for (const id of ['yujin', 'jie-yujin-b45', 'mou-yujin-b48', 'sp-yujin-b57']) {
      const character = getCharacter(id)
      expect(character, id).toBeDefined()
      for (const skill of character!.skills) expect(getSkillRuntime(skill.id), skill.id).toBeDefined()
    }
  })
})
