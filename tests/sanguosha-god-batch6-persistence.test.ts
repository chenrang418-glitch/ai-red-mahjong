import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { createCharacterWeapon, isCharacterEquipment } from '@/sanguosha/engine/character-equipment'
import { deckReshuffledThisTurn, reshuffleDrawPile } from '@/sanguosha/engine/deck'
import { equipmentSlotsOf, grantExtraWeaponSlot, hasExtraWeaponSlot } from '@/sanguosha/engine/equipment-slots'
import { DIJI_STATE, QIHAI_STATE, applyTargetState, hasTargetState } from '@/sanguosha/engine/target-state'
import { dyingCausedBy, markDyingCause } from '@/sanguosha/engine/death-cause'
import { getAttackRange } from '@/sanguosha/engine/distance'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { skillIdsOf } from '@/sanguosha/data/characters/standard'
import { moveCard } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'

/**
 * 第六批带进来的新状态**必须能过一遍存盘重建**。
 *
 * Durable Object 随时会休眠，重连之后这些东西要一模一样地回来：
 * 洗牌痕迹、第二武器栏、武将牌装备（连同它借出的技能）、阶段替换、
 * 部位状态、临时技能批次、因果标记。
 *
 * 单独写这一条是因为通用的持久化用例是从全部武将里随机取阵容跑整局，
 * 这四个人被抽中的概率很低——「那条绿了」并不能说明这些字段被覆盖过。
 */

function gameAt(seed: string, characterIds: string[]): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
    player.characterId = characterIds[index]
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  /*
   * 开局会冒出各种请求（选将、挈挟看武将、驭衡弃牌……），
   * 这里一律给「最小承诺」的合法回答：选将取第一个，其余一概不选。
   * 用统一的 `respond-pass` 是不行的——不同请求的回应格式不一样，
   * 格式不对会被校验直接打回来。
   */
  for (let guard = 0; guard < 400 && game.state.pendingRequests.length > 0; guard += 1) {
    const request = game.state.pendingRequests[0] as { id: string; playerId: string; kind: string }
    const payload: Record<string, unknown> = (() => {
      switch (request.kind) {
        case 'choose-general': return { characterId: (request as unknown as { candidates: string[] }).candidates[0] }
        case 'choose-options': return { optionIds: [] }
        case 'choose-cards': return { cardIds: [] }
        case 'choose-targets': return { targetIds: [] }
        case 'choose-option': {
          const options = (request as unknown as { options: { id: string }[] }).options
          return { optionId: options[options.length - 1].id }
        }
        case 'arrange-cards': {
          const pick = request as unknown as { cardIds: string[] }
          return { top: [...pick.cardIds], bottom: [] }
        }
        case 'rescue': return { actionId: 'rescue-pass' }
        default: return { actionId: 'respond-pass' }
      }
    })()
    game.respond({ requestId: request.id, playerId: request.playerId, payload })
  }
  return game
}

/** 存一次盘再读回来，模拟 Durable Object 休眠。 */
function roundTrip(game: SanguoshaGame): SanguoshaGame {
  return SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
}

describe('第六批：重连之后状态一模一样', () => {
  it('洗牌痕迹过得去存盘', () => {
    const game = gameAt('b6-persist-deck', ['shenzhangjiao', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    for (const cardId of game.state.zones.drawPile.slice(0, 5)) {
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    }
    reshuffleDrawPile(game.state, game.rng)
    expect(deckReshuffledThisTurn(game.state)).toBe(true)

    const restored = roundTrip(game)
    expect(deckReshuffledThisTurn(restored.state), '重连之后仍然知道这回合洗过牌').toBe(true)
    expect(restored.state.deckReshuffle?.count).toBe(game.state.deckReshuffle?.count)
  })

  it('第二武器栏、武将牌装备和它借出的技能都过得去存盘', () => {
    const game = gameAt('b6-persist-weapon', ['shendianwei', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    grantExtraWeaponSlot(game.state, 'p0')
    const cardId = createCharacterWeapon(game.state, 'guanyu', '关羽', 4)
    moveCard(game.state, cardId, { kind: 'processingArea' }, { kind: 'equipment', playerId: 'p0', slot: 'weapon2' })
    const rangeBefore = getAttackRange(game.state, 'p0')
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf)).toContain('wusheng')

    const restored = roundTrip(game)
    expect(hasExtraWeaponSlot(restored.state, 'p0'), '额外武器栏还在').toBe(true)
    expect(equipmentSlotsOf(restored.state, 'p0')).toContain('weapon2')
    expect(isCharacterEquipment(restored.state, cardId), '武将装备还是武将装备').toBe(true)
    expect(restored.state.cards[cardId].characterId, '背后是哪名武将也记着').toBe('guanyu')
    expect(getAttackRange(restored.state, 'p0'), '攻击范围一样').toBe(rangeBefore)
    expect(ownedSkillIds(restored.state, 'p0', skillIdsOf), '借来的技能重连之后仍然生效').toContain('wusheng')
  })

  it('部位状态和因果标记过得去存盘', () => {
    const game = gameAt('b6-persist-injury', ['shenhuangzhong', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    applyTargetState(game.state, 'p1', DIJI_STATE, 'p0', 'lieqiong', 'owner-turn-end')
    applyTargetState(game.state, 'p2', QIHAI_STATE, 'p0', 'lieqiong', 'owner-turn-end')
    markDyingCause(game.state, 'p1', 'tianchong', 'p0')

    const restored = roundTrip(game)
    expect(hasTargetState(restored.state, 'p1', DIJI_STATE)).toBe(true)
    expect(hasTargetState(restored.state, 'p2', QIHAI_STATE)).toBe(true)
    expect(
      restored.state.targetStates?.find((entry) => entry.ownerId === 'p1')?.expiry,
      '到期口径也要带过来，否则它会变成永不过期或者立刻过期',
    ).toBe('owner-turn-end')
    expect(dyingCausedBy(restored.state, 'p1', 'tianchong', 'p0'), '因果标记还在').toBe(true)
  })

  it('阶段替换和临时技能批次过得去存盘', () => {
    const game = gameAt('b6-persist-phase', ['shensunquan', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    const owner = game.state.players.find((player) => player.id === 'p0')!
    owner.grantedSkills.push('chigang')
    owner.temporaryGrantedSkills = [
      { source: 'yuheng', skillId: 'qixi' },
      { source: 'yuheng', skillId: 'kurou' },
    ]
    owner.marks['yuheng-count'] = 2
    game.state.phaseReplacedFrom = 'judge'
    game.state.phase = 'draw'

    const restored = roundTrip(game)
    const after = restored.state.players.find((player) => player.id === 'p0')!
    expect(restored.state.phaseReplacedFrom, '还知道这个摸牌阶段是判定位换来的').toBe('judge')
    expect(restored.state.phase).toBe('draw')
    expect(after.temporaryGrantedSkills, '这一批临时技能一个都不能少').toHaveLength(2)
    expect(after.marks['yuheng-count'], '回合结束按它摸牌').toBe(2)
    expect(ownedSkillIds(restored.state, 'p0', skillIdsOf), '临时技能重连之后仍然生效').toContain('qixi')
  })

  it('旧存档里没有这些新字段时，按安全默认值补', () => {
    const game = gameAt('b6-persist-legacy', ['shenzhangjiao', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    const stored = JSON.parse(JSON.stringify(game.serialize())) as Record<string, unknown>
    /*
     * 模拟一个在这些字段加进来之前存下的房间：把它们全删掉。
     * 补默认值必须是**安全**的——比如洗牌痕迹补成「没洗过」，
     * 而不是「洗过」，否则重连之后会凭空多给一次天劫。
     */
    delete stored.deckReshuffle
    delete stored.extraWeaponSlots
    delete stored.phaseReplacedFrom
    for (const player of stored.players as Array<{ zones: { equipment: Record<string, unknown> } }>) {
      delete player.zones.equipment.weapon2
    }

    const restored = SanguoshaGame.restore(stored as never)
    expect(deckReshuffledThisTurn(restored.state), '旧存档按「没洗过」补').toBe(false)
    expect(hasExtraWeaponSlot(restored.state, 'p0'), '旧存档没有额外武器栏').toBe(false)
    for (const player of restored.state.players) {
      expect(player.zones.equipment.weapon2, '第二武器栏补成空的').toBeNull()
    }
    expect(restored.state.phaseReplacedFrom, '没有替换就是没有').toBeUndefined()
  })
})
