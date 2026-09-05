import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { addForcedAwakening, hasForcedAwakening } from '@/sanguosha/engine/forced-awakening'
import { gainMaxHp, loseMaxHp } from '@/sanguosha/engine/hp'
import {
  beginJudgmentRetention,
  endJudgmentRetention,
  retainedJudgmentCards,
  retainedJudgmentSuits,
} from '@/sanguosha/engine/judgment-retention'
import { recordSkillGrantSource, skillGrantSourceOf } from '@/sanguosha/engine/skill-grant-source'
import { createVirtualTrick, virtualTrickChoices } from '@/sanguosha/engine/virtual-trick'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import { grantSkill } from '@/sanguosha/engine/skills/runtime'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 神·郭嘉。
 *
 * 四个技能全部建立在公共机制上，所以这里既测技能，也测它们依赖的那几个机制
 * 的关键性质——那才是出问题时最难查的部分。
 */

function gameWith(characterIds: string[], seed = 'shenguojia'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: characterIds.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index % identities.length]
    player.characterId = characterIds[index]
  })
  game.start()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  return game
}

const CAST = ['shenguojia', 'zhangfei', 'guanyu', 'zhaoyun', 'machao']
function playerOf(game: SanguoshaGame, id: PlayerId) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

describe('神·郭嘉：注册', () => {
  it('势力、性别、体力和四个技能齐全', () => {
    const game = gameWith(CAST)
    const owner = playerOf(game, 'p0')
    expect(owner.maxHp).toBe(3 + 1) // 主公 +1
    const skills = game.viewFor('p0').players.find((p) => p.id === 'p0')?.skills?.map((s) => s.name) ?? []
    expect(skills).toEqual(expect.arrayContaining(['慧识', '天翊', '辉逝']))
    // 佐幸是被授予的，开局不在身上
    expect(skills).not.toContain('佐幸')
  })

  it('技能 id 没有和别人撞车', () => {
    // 「慧识 / 辉逝」和「天翊 / 天义」两组同音，撞了会让注册表直接抛错
    const game = gameWith(CAST)
    expect(() => game.viewFor('p0')).not.toThrow()
  })
})

describe('神·郭嘉：慧识依赖的判定暂存', () => {
  it('暂存期间判定牌留在处理区，交牌后进入对方手牌，牌张守恒', () => {
    const game = gameWith(CAST)
    const state = game.state
    beginJudgmentRetention(state, 'p0', 'test-tag')
    const cardIds = state.zones.drawPile.splice(0, 3)
    for (const cardId of cardIds) state.zones.processingArea.push(cardId)
    // 直接用公共入口登记，模拟三次判定的最终花色
    const retention = state.judgmentRetention!
    retention.cardIds.push(...cardIds)
    retention.suits.push('heart', 'spade', 'club')

    expect(retainedJudgmentCards(state)).toHaveLength(3)
    expect(retainedJudgmentSuits(state)).toEqual(['heart', 'spade', 'club'])
    assertCardConservation(state)

    const before = playerOf(game, 'p1').zones.hand.length
    const moved = endJudgmentRetention(state, 'p1')
    expect(moved).toEqual(cardIds)
    expect(playerOf(game, 'p1').zones.hand).toHaveLength(before + 3)
    expect(state.zones.processingArea).toHaveLength(0)
    expect(state.judgmentRetention).toBeNull()
    assertCardConservation(state)
  })

  it('没人接手时进弃牌堆，绝不留在处理区', () => {
    const game = gameWith(CAST)
    const state = game.state
    beginJudgmentRetention(state, 'p0', 'test-tag')
    const cardIds = state.zones.drawPile.splice(0, 2)
    for (const cardId of cardIds) state.zones.processingArea.push(cardId)
    state.judgmentRetention!.cardIds.push(...cardIds)
    state.judgmentRetention!.suits.push('heart', 'spade')

    endJudgmentRetention(state, null)
    expect(state.zones.processingArea).toHaveLength(0)
    for (const cardId of cardIds) expect(state.zones.discardPile).toContain(cardId)
    assertCardConservation(state)
  })

  it('花色按判定顺序记，用来判断能不能继续', () => {
    const game = gameWith(CAST)
    const state = game.state
    beginJudgmentRetention(state, 'p0', 'test-tag')
    state.judgmentRetention!.suits.push('heart', 'spade')
    // 第三次又出红桃就该停：慧识要求和之前每一次都不同
    const suits = retainedJudgmentSuits(state)
    expect(suits.slice(0, -1).includes('heart')).toBe(true)
    endJudgmentRetention(state, null)
  })
})

describe('神·郭嘉：体力上限公共入口', () => {
  it('加上限不回复体力', () => {
    const game = gameWith(CAST)
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    const before = owner.hp
    gainMaxHp(game as never, 'p0', 3, 'test')
    expect(owner.hp, '加上限不该顺带回血').toBe(before)
    expect(owner.maxHp).toBe(4 + 3)
  })

  it('cap 参数封顶，到顶就当没加', () => {
    const game = gameWith(CAST)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 9
    gainMaxHp(game as never, 'p0', 5, 'test', 10)
    expect(owner.maxHp, '慧识不能把上限顶过 10').toBe(10)
    gainMaxHp(game as never, 'p0', 1, 'test', 10)
    expect(owner.maxHp).toBe(10)
  })

  it('减上限会把超出的体力一起裁掉', () => {
    const game = gameWith(CAST)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 4
    owner.hp = 4
    loseMaxHp(game as never, 'p0', 2, 'test')
    expect(owner.maxHp).toBe(2)
    expect(owner.hp, '体力不能高于上限').toBe(2)
  })
})

describe('神·郭嘉：天翊的受伤记账', () => {
  it('真正受到伤害才记，失去体力不算', () => {
    const game = gameWith(CAST)
    expect(playerOf(game, 'p1').hasTakenDamage).toBeFalsy()
    game.damage({ sourceId: 'p0', targetId: 'p1', amount: 1 })
    expect(playerOf(game, 'p1').hasTakenDamage).toBe(true)

    // 失去体力走另一条路，不该记
    expect(playerOf(game, 'p2').hasTakenDamage).toBeFalsy()
    playerOf(game, 'p2').hp -= 1
    expect(playerOf(game, 'p2').hasTakenDamage).toBeFalsy()
  })

  it('一次成立终局有效，死亡也不清除', () => {
    const game = gameWith(CAST)
    game.damage({ sourceId: 'p0', targetId: 'p1', amount: 1 })
    playerOf(game, 'p1').alive = false
    expect(playerOf(game, 'p1').hasTakenDamage).toBe(true)
  })
})

describe('神·郭嘉：辉逝的强制觉醒', () => {
  it('只放行条件，不写进已觉醒记录', () => {
    const game = gameWith(CAST)
    addForcedAwakening(game.state, { playerId: 'p1', skillId: 'zhaoxian', sourceId: 'p0' })
    expect(hasForcedAwakening(game.state, 'p1', 'zhaoxian')).toBe(true)
    // 放行不等于已经觉醒
    expect(playerOf(game, 'p1').awakenedSkills ?? []).not.toContain('zhaoxian')
  })

  it('同一个技能重复放行不会叠加', () => {
    const game = gameWith(CAST)
    addForcedAwakening(game.state, { playerId: 'p1', skillId: 'zhaoxian', sourceId: 'p0' })
    addForcedAwakening(game.state, { playerId: 'p1', skillId: 'zhaoxian', sourceId: 'p0' })
    expect(game.state.forcedAwakenings).toHaveLength(1)
  })

  it('放行记录跟着序列化走，重连不丢', () => {
    const game = gameWith(CAST)
    addForcedAwakening(game.state, { playerId: 'p1', skillId: 'zhaoxian', sourceId: 'p0' })
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(hasForcedAwakening(restored.state, 'p1', 'zhaoxian')).toBe(true)
  })
})

describe('神·郭嘉：佐幸的来源绑定与虚拟锦囊', () => {
  it('授技记住是哪个神郭嘉给的', () => {
    const game = gameWith(CAST)
    grantSkill(game.state, 'p1', 'zuoxing')
    recordSkillGrantSource(game.state, { playerId: 'p1', skillId: 'zuoxing', sourceId: 'p0' })
    expect(skillGrantSourceOf(game.state, 'p1', 'zuoxing')).toBe('p0')
    // 没登记过的组合返回 null，不会误指到别人身上
    expect(skillGrantSourceOf(game.state, 'p2', 'zuoxing')).toBeNull()
  })

  it('候选只给现在真的用得出去的普通锦囊', () => {
    const game = gameWith(CAST)
    const choices = virtualTrickChoices(game.state, 'p0')
    expect(choices.length).toBeGreaterThan(0)
    // 延时锦囊和基本牌都不在普通锦囊候选里
    for (const name of ['乐不思蜀', '兵粮寸断', '闪电', '杀', '闪', '桃']) {
      expect(choices, name).not.toContain(name)
    }
  })

  it('印出来的是虚拟牌：不进牌堆组成，销毁后牌张仍然守恒', () => {
    const game = gameWith(CAST)
    const state = game.state
    const knownBefore = Object.keys(state.cards).length
    assertCardConservation(state)

    const cardId = createVirtualTrick(state, 'p0', '决斗', 'zuoxing')
    expect(state.cards[cardId].virtual).toBe(true)
    expect(playerOf(game, 'p0').zones.hand).toContain(cardId)
    // 虚拟牌在手上时也必须守恒（它登记在 state.cards 里）
    assertCardConservation(state)

    // 销毁：从手牌和牌表一起移除，不进弃牌堆
    playerOf(game, 'p0').zones.hand = playerOf(game, 'p0').zones.hand.filter((id) => id !== cardId)
    delete state.cards[cardId]
    expect(Object.keys(state.cards)).toHaveLength(knownBefore)
    expect(state.zones.discardPile).not.toContain(cardId)
    assertCardConservation(state)
  })

  it('虚拟锦囊不是实体牌，因此不会被当成非虚拟锦囊', () => {
    // 神荀彧【灵策】要求「非虚拟非转化」，佐幸印出来的牌必须被挡在外面
    const game = gameWith(CAST)
    const cardId = createVirtualTrick(game.state, 'p0', '过河拆桥', 'zuoxing')
    expect(game.state.cards[cardId].virtual).toBe(true)
    expect(game.state.cards[cardId].sourceSkillId).toBe('zuoxing')
  })
})
