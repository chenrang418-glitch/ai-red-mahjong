import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { HUASHEN, XINSHENG } from '@/sanguosha/data/characters/mountain-zuoci'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import {
  activateHuashen, effectiveGenderOf, effectiveKingdomOf, huashenCharacter, huashenEligibilityReport,
} from '@/sanguosha/engine/huashen'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { ownedSkillIds, skillsOf } from '@/sanguosha/engine/skills/runtime'
import type { GameSetup, Identity, SanguoshaState } from '@/sanguosha/engine/types'

function gameWith(characters = ['zuoci', 'caocao', 'liubei', 'sunquan', 'caiwenji']): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: characters.map((_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed: 'zuoci-classic', setup })
  const identities: Identity[] = ['lord', 'loyalist', 'rebel', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = characters[index]
    const character = getCharacter(characters[index])!
    player.maxHp = character.maxHp + (index === 0 ? 1 : 0)
    player.hp = player.maxHp
  })
  game.start()
  return game
}

function answer(game: SanguoshaGame, payload: Record<string, unknown>): void {
  const request = game.state.pendingRequests[0]
  if (!request) throw new Error('没有待处理请求')
  game.respond({ requestId: request.id, playerId: request.playerId, payload })
}

function finishInitialHuashen(game: SanguoshaGame, characterIndex = 0, skillIndex = 0): { characterId: string; skillId: string } {
  const characterRequest = game.state.pendingRequests[0]
  expect(characterRequest.kind).toBe('choose-option')
  const characterId = characterRequest.kind === 'choose-option' ? characterRequest.options[characterIndex].id : ''
  answer(game, { optionId: characterId })
  const skillRequest = game.state.pendingRequests[0]
  expect(skillRequest.kind).toBe('choose-option')
  const skillId = skillRequest.kind === 'choose-option' ? skillRequest.options[skillIndex].id : ''
  answer(game, { optionId: skillId })
  return { characterId, skillId }
}

function huashenState(game: SanguoshaGame) {
  return game.state.huashen!.owners.p0
}

describe('山包左慈', () => {
  it('注册经典基础信息与化身、新生', () => {
    const character = getCharacter('zuoci')!
    expect([character.kingdom, character.gender, character.maxHp, character.pack]).toEqual(['qun', 'male', 3, 'mountain'])
    expect(skillIdsOf('zuoci')).toEqual([HUASHEN, XINSHENG])
  })

  it('开局从共享经典池随机取得两张不在场武将，且必须选择化身与合法普通技能', () => {
    const game = gameWith()
    const owner = huashenState(game)
    expect(owner.characterIds).toHaveLength(2)
    expect(new Set(owner.characterIds).size).toBe(2)
    expect(owner.characterIds).not.toContain('zuoci')
    expect(owner.characterIds.some((id) => game.state.players.some((player) => player.characterId === id))).toBe(false)
    expect(owner.characterIds.every((id) => huashenCharacter(id)?.pack !== 'entertainment')).toBe(true)
    const selected = finishInitialHuashen(game)
    expect(owner.activeCharacterId).toBe(selected.characterId)
    expect(owner.activeSkillId).toBe(selected.skillId)
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf)).toEqual(expect.arrayContaining([HUASHEN, XINSHENG, selected.skillId]))
    assertGameInvariants(game.state)
  })

  it('拥有者可见全部化身，其他玩家和断线重连视图只见当前亮出的化身', () => {
    const game = gameWith()
    const selected = finishInitialHuashen(game)
    const hiddenId = huashenState(game).characterIds.find((id) => id !== selected.characterId)!
    const ownerView = game.viewFor('p0').players[0].huashen!
    const otherView = game.viewFor('p1').players[0].huashen!
    expect(ownerView.ownedCharacterIds).toEqual(huashenState(game).characterIds)
    expect(otherView.activeCharacterId).toBe(selected.characterId)
    expect(Object.prototype.hasOwnProperty.call(otherView, 'ownedCharacterIds')).toBe(false)
    expect(JSON.stringify(game.viewFor('p1'))).not.toContain(`\"${hiddenId}\"`)

    const restored = SanguoshaGame.restore(game.serialize())
    const reconnectView = restored.viewFor('p1').players[0].huashen!
    expect(reconnectView.activeCharacterId).toBe(selected.characterId)
    expect(Object.prototype.hasOwnProperty.call(reconnectView, 'ownedCharacterIds')).toBe(false)
  })

  it('更换时原临时技能立即移除，可对同一化身重新选择另一项技能', () => {
    const game = gameWith()
    const owner = huashenState(game)
    owner.characterIds = ['caocao', 'sunquan']
    owner.activeCharacterId = null
    owner.activeSkillId = null
    game.state.pendingRequests = []
    game.state.skillResolution = null
    expect(activateHuashen(game.state, 'p0', 'caocao', 'jianxiong')).toBe(true)
    game.state.skillQueue.push({ skillId: 'jianxiong', ownerId: 'p0', step: 'stale', data: {} })
    expect(activateHuashen(game.state, 'p0', 'sunquan', 'zhiheng')).toBe(true)
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf)).not.toContain('jianxiong')
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf)).toContain('zhiheng')
    expect(game.state.skillQueue.some((prompt) => prompt.skillId === 'jianxiong')).toBe(false)
    expect(activateHuashen(game.state, 'p0', 'sunquan', 'jiuyuan')).toBe(false)
  })

  it('当前化身统一改变势力、性别并启用对应运行时，断肠后恢复本体且关闭全部武将技', () => {
    const game = gameWith()
    finishInitialHuashen(game)
    huashenState(game).characterIds = ['zhenji']
    expect(activateHuashen(game.state, 'p0', 'zhenji', 'qingguo')).toBe(true)
    expect(effectiveKingdomOf(game.state, 'p0')).toBe('wei')
    expect(effectiveGenderOf(game.state, 'p0')).toBe('female')
    expect(skillsOf(game.state, 'p0', skillIdsOf).some((skill) => skill.id === 'qingguo')).toBe(true)
    game.state.players[0].characterSkillsDisabled = true
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf)).toEqual([])
    expect(effectiveKingdomOf(game.state, 'p0')).toBe('qun')
    expect(effectiveGenderOf(game.state, 'p0')).toBe('male')
    expect(game.viewFor('p1').players[0].huashen).toMatchObject({ activeCharacterId: null, activeSkillId: null })
  })

  it('依靠不屈在0血存活时换掉不屈，会立刻重新进入濒死而非留下0血活人', () => {
    const game = gameWith()
    finishInitialHuashen(game)
    const owner = huashenState(game)
    owner.characterIds = ['zhoutai', 'caocao']
    expect(activateHuashen(game.state, 'p0', 'zhoutai', 'buqu')).toBe(true)
    game.state.players[0].hp = 0
    game.state.pendingRequests = []
    game.state.skillResolution = null
    game.dispatch('TurnStart', { playerId: 'p0' }); (game as unknown as { settle(): void }).settle()
    answer(game, { optionId: 'yes' })
    answer(game, { optionId: 'caocao' })
    answer(game, { optionId: 'jianxiong' })
    expect(game.state.dying?.playerId).toBe('p0')
    expect(game.state.pendingRequests[0]?.kind).toBe('rescue')
  })

  it('每点伤害各询问一次新生，获得新牌不改变当前化身且池耗尽时安全停止', () => {
    const game = gameWith()
    const selected = finishInitialHuashen(game)
    const before = huashenState(game).characterIds.length
    game.dispatch('Damaged', { amount: 2 }, { sourceId: 'p1', targetId: 'p0' })
    ;(game as unknown as { settle(): void }).settle()
    answer(game, { optionId: 'yes' })
    answer(game, { optionId: 'yes' })
    expect(huashenState(game).characterIds).toHaveLength(before + 2)
    expect(huashenState(game).activeCharacterId).toBe(selected.characterId)
    expect(huashenState(game).activeSkillId).toBe(selected.skillId)
    game.state.huashen!.remainingCharacterIds = []
    game.dispatch('Damaged', { amount: 1 }, { sourceId: 'p1', targetId: 'p0' })
    ;(game as unknown as { settle(): void }).settle()
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('新生中途序列化恢复后只继续剩余次数，不重复抽取', () => {
    const game = gameWith()
    finishInitialHuashen(game)
    game.dispatch('Damaged', { amount: 2 }, { sourceId: 'p1', targetId: 'p0' })
    ;(game as unknown as { settle(): void }).settle()
    answer(game, { optionId: 'yes' })
    const count = huashenState(game).characterIds.length
    const restored = SanguoshaGame.restore(game.serialize())
    expect(restored.state.pendingRequests).toHaveLength(1)
    answer(restored, { optionId: 'yes' })
    expect(huashenState(restored).characterIds).toHaveLength(count + 1)
    expect(restored.state.pendingRequests).toHaveLength(0)
  })

  it('多个左慈共享唯一牌池，不会取得同一张化身', () => {
    const game = gameWith(['zuoci', 'zuoci', 'liubei', 'sunquan', 'caiwenji'])
    const first = game.state.huashen!.owners.p0.characterIds
    const second = game.state.huashen!.owners.p1.characterIds
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    expect(new Set([...first, ...second]).size).toBe(4)
  })

  it('资格审计只按限定、觉醒、主公规则排除，不存在漏实现普通技能', () => {
    const report = huashenEligibilityReport()
    expect(report.eligible.length).toBeGreaterThan(0)
    expect(report.excludedByRule).toEqual(expect.arrayContaining(['niepan', 'luanwu', 'hujia', 'jijiang', 'hunzi']))
    expect(report.incompatibleBug).toEqual([])
  })

  it('逐个挂载、恢复并卸载全部合法化身技能，无双技能或旧技能残留', () => {
    const game = gameWith()
    finishInitialHuashen(game)
    const owner = huashenState(game)
    const candidates = ALL_CHARACTERS.filter((character) => character.pack !== 'entertainment' && character.id !== 'zuoci')
    const mounted = new Set<string>()
    for (const character of candidates) {
      const eligible = character.skills.filter((skill) => !skill.granted && huashenEligibilityReport().eligible.includes(skill.id))
      if (eligible.length === 0) continue
      owner.characterIds = [character.id]
      for (const skill of eligible) {
        expect(activateHuashen(game.state, 'p0', character.id, skill.id), `${character.name}/${skill.name}`).toBe(true)
        expect(game.state.players[0].temporaryGrantedSkills.filter((entry) => entry.source === 'huashen:p0')).toEqual([{ source: 'huashen:p0', skillId: skill.id }])
        const restored = SanguoshaGame.restore(game.serialize())
        expect(ownedSkillIds(restored.state, 'p0', skillIdsOf)).toContain(skill.id)
        expect(() => restored.legalActions('p0')).not.toThrow()
        mounted.add(skill.id)
      }
    }
    expect(mounted.size).toBe(huashenEligibilityReport().eligible.length)
  })

  it('动态势力参与制霸授权，动态性别参与结姻目标筛选', () => {
    const game = gameWith(['zuoci', 'sunce', 'sunshangxiang', 'zhangfei', 'caiwenji'])
    finishInitialHuashen(game)
    const owner = huashenState(game)
    owner.characterIds = ['sunquan', 'zhenji', 'caocao']
    game.state.players[1].identity = 'lord'
    game.state.players[0].identity = 'loyalist'
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    expect(activateHuashen(game.state, 'p0', 'sunquan', 'zhiheng')).toBe(true)
    expect(game.legalActions('p0').some((action) => action.skillId === 'zhiba')).toBe(true)

    game.state.players.forEach((player) => { player.hp = player.maxHp })
    game.state.players[0].hp -= 1
    game.state.currentPlayerId = 'p2'
    expect(activateHuashen(game.state, 'p0', 'zhenji', 'qingguo')).toBe(true)
    expect(game.legalActions('p2').some((action) => action.skillId === 'jieyin')).toBe(false)
    expect(activateHuashen(game.state, 'p0', 'caocao', 'jianxiong')).toBe(true)
    expect(game.legalActions('p2').some((action) => action.skillId === 'jieyin')).toBe(true)
  })

  it('只在自己的回合开始与结束产生切换窗口，AI能完成开局选择与新生响应', async () => {
    const game = gameWith()
    finishInitialHuashen(game)
    game.dispatch('TurnStart', { playerId: 'p1' }); (game as unknown as { settle(): void }).settle()
    expect(game.state.pendingRequests).toHaveLength(0)
    game.dispatch('TurnStart', { playerId: 'p0' }); (game as unknown as { settle(): void }).settle()
    expect(game.state.pendingRequests[0]?.prompt).toContain('回合开始时')
    answer(game, { optionId: 'no' })
    game.dispatch('TurnEnd', { playerId: 'p0' }); (game as unknown as { settle(): void }).settle()
    expect(game.state.pendingRequests[0]?.prompt).toContain('回合结束后')
    answer(game, { optionId: 'no' })

    const { decideResponse } = await import('@/sanguosha/ai')
    const { emptySuspicion } = await import('@/sanguosha/ai/belief')
    const { GameRng } = await import('@/sanguosha/engine/rng')
    const aiGame = gameWith()
    while (aiGame.state.pendingRequests.length > 0) {
      const request = aiGame.state.pendingRequests[0]
      const view = aiGame.viewFor(request.playerId)
      aiGame.respond(decideResponse({ view, difficulty: 'hard', rng: new GameRng('zuoci-ai'), suspicion: emptySuspicion(view) }, request))
    }
    expect(huashenState(aiGame).activeSkillId).not.toBeNull()
    aiGame.dispatch('Damaged', { amount: 1 }, { sourceId: 'p1', targetId: 'p0' }); (aiGame as unknown as { settle(): void }).settle()
    const request = aiGame.state.pendingRequests[0]
    const view = aiGame.viewFor('p0')
    const before = huashenState(aiGame).characterIds.length
    aiGame.respond(decideResponse({ view, difficulty: 'hard', rng: new GameRng('zuoci-ai-newborn'), suspicion: emptySuspicion(view) }, request))
    expect(huashenState(aiGame).characterIds).toHaveLength(before + 1)
  })

  it('真实推进回合时先完成回合结束化身，再开始下一名角色的回合，且断点可重连', () => {
    const game = gameWith()
    finishInitialHuashen(game)
    game.state.phase = 'finish'
    game.advancePhase()
    expect(game.state.currentPlayerId).toBe('p0')
    expect(game.state.turnTransitionPending).toBe(true)
    expect(game.state.pendingRequests[0]?.prompt).toContain('回合结束后')

    const restored = SanguoshaGame.restore(game.serialize())
    expect(restored.state.currentPlayerId).toBe('p0')
    expect(restored.state.turnTransitionPending).toBe(true)
    answer(restored, { optionId: 'no' })
    expect(restored.state.turnTransitionPending).toBe(false)
    expect(restored.state.currentPlayerId).toBe('p1')
    expect(restored.state.phase).toBe('prepare')
  })

  it('新生公开事件不携带新化身身份，旁观请求视图也不泄漏', () => {
    const game = gameWith()
    finishInitialHuashen(game)
    const publicPayloads: unknown[] = []
    game.events.on('SkillActivated', (context) => { publicPayloads.push(context.event.payload) })
    game.dispatch('Damaged', { amount: 1 }, { sourceId: 'p1', targetId: 'p0' }); (game as unknown as { settle(): void }).settle()
    expect(game.viewFor('p1').pendingRequest).toBeNull()
    answer(game, { optionId: 'yes' })
    const payload = JSON.stringify(publicPayloads.at(-1))
    for (const characterId of huashenState(game).characterIds) {
      if (characterId !== huashenState(game).activeCharacterId) expect(payload).not.toContain(characterId)
    }
  })

  it('完整状态可结构化克隆，化身字段不含不可序列化内容', () => {
    const game = gameWith()
    finishInitialHuashen(game)
    const state: SanguoshaState = game.serialize()
    expect(structuredClone(state).huashen).toEqual(state.huashen)
  })
})
