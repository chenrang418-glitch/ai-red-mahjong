import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime, isTargetProhibited } from '@/sanguosha/engine/skills/runtime'
import { skillIdsOf } from '@/sanguosha/data/characters/standard'
import { moveCard } from '@/sanguosha/engine/zones'
import { startPindian } from '@/sanguosha/engine/pindian'
import { slashRules } from '@/sanguosha/engine/slash-rules'
import type { PlayerId } from '@/sanguosha/engine/types'

const BATCH64_NAMES = [
  '标袁术', '界·徐庶', '界·李典', '界·太史慈', '界·贾诩',
  '界·鲁肃', '界·张郃', '界·陈宫', '界·张春华', '界·曹冲',
]

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })),
  } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

describe('武将册第64批（注册与关键公共规则）', () => {
  it('十名武将均进入正式池，所有技能均有运行时', () => {
    const characters = BATCH64_NAMES.map((name) => ALL_CHARACTERS.find((character) => character.name === name))
    expect(characters.every(Boolean)).toBe(true)
    expect(new Set(characters.map((character) => character!.id)).size).toBe(10)
    for (const character of characters) {
      for (const skill of character!.skills) expect(getSkillRuntime(skill.id), `${character!.name}【${skill.name}】`).toBeDefined()
    }
  })

  it('标袁术【同疾】在全局目标合法性入口拦截对其他角色使用的杀', () => {
    const game = gameFor('b64-tongji')
    const [source, owner, victim] = game.state.players
    source!.characterId = 'plain-test-character'
    owner!.characterId = 'biao-yuanshu-b64'
    victim!.characterId = 'plain-test-character'
    owner!.hp = 2
    owner!.zones.hand.push(...game.state.zones.drawPile.splice(0, 3))
    expect(isTargetProhibited(game.state, source!.id, victim!.id, '杀', undefined, skillIdsOf)).toBe(true)
    expect(isTargetProhibited(game.state, source!.id, owner!.id, '杀', undefined, skillIdsOf)).toBe(false)
  })

  it('界贾诩【完杀】全局失效钩子仅在其回合濒死结算中压制第三方非锁定技', () => {
    const game = gameFor('b64-wansha')
    const [jiaxu, dying, third] = game.state.players
    jiaxu!.characterId = 'jie-jiaxu-b64'
    game.state.currentPlayerId = jiaxu!.id
    game.state.dying = { playerId: dying!.id, sourceId: third!.id, requestedBy: null } as never
    const runtime = getSkillRuntime('wansha')!
    expect(runtime.globallyInvalidatesOtherSkills?.(game.state, jiaxu!.id, third!.id)).toBe(true)
    expect(runtime.globallyInvalidatesOtherSkills?.(game.state, jiaxu!.id, dying!.id)).toBe(false)
    game.state.currentPlayerId = third!.id
    expect(runtime.globallyInvalidatesOtherSkills?.(game.state, jiaxu!.id, third!.id)).toBe(false)
  })

  it('界张郃【巧变】开局获得两枚“变”标记', () => {
    const game = gameFor('b64-qiaobian')
    const owner = game.state.players[0]!
    owner.characterId = 'jie-zhanghe-b64'
    getSkillRuntime('qiaobian')!.onGameStart?.(game as never, owner.id as PlayerId)
    expect(owner.marks['变']).toBe(2)
  })

  it('界太史慈拼点赢且发动【酣战】取杀时，天义胜利效果仍然结算', () => {
    const game = gameFor('b64-hanzhan-tianyi')
    const [owner, opponent] = game.state.players
    owner!.characterId = 'jie-taishici-b64'
    opponent!.characterId = 'plain-test-character'
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀' && !game.state.cards[id]?.damageNature)!
    const opponentCardId = game.state.zones.drawPile.find((id) => id !== slashId && game.state.cards[id]?.rank === 7 && game.state.cards[id]?.name !== '杀')!
    game.state.cards[slashId]!.rank = 13
    moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    moveCard(game.state, opponentCardId, { kind: 'drawPile' }, { kind: 'hand', playerId: opponent!.id })

    startPindian(game as never, {
      id: 'b64-hanzhan-pindian', initiatorId: owner!.id, opponentId: opponent!.id,
      reason: 'tianyi', continuationTag: 'tianyi',
    })
    for (const request of [...game.state.pendingRequests]) {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: [request.playerId === owner!.id ? slashId : opponentCardId] } })
    }

    expect(slashRules(game.state, owner!.id)).toMatchObject({ extraUses: 1, extraTargets: 1, ignoreDistance: true, prohibited: false })
    const hanzhanRequest = game.state.pendingRequests.at(-1)!
    expect(hanzhanRequest).toMatchObject({ kind: 'choose-option', skillId: 'tianyi' })
    game.respond({ requestId: hanzhanRequest.id, playerId: owner!.id, payload: { optionId: 'yes' } })
    expect(owner!.zones.hand).toContain(slashId)
    expect(game.state.pindianSettlement).toBeNull()
  })

  it('界徐庶【荐言】直接取得牌堆中第一张命中牌，不把未命中牌翻出或弃置', () => {
    const game = gameFor('b64-jianyan-search')
    const [owner, recipient] = game.state.players
    owner!.characterId = 'jie-xushu-b64'
    recipient!.characterId = 'taishici'
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const missedId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.suit === 'spade')!
    const matchedId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.suit === 'heart')!
    game.state.zones.drawPile.splice(game.state.zones.drawPile.indexOf(matchedId), 1)
    game.state.zones.drawPile.unshift(matchedId)
    game.state.zones.drawPile.splice(game.state.zones.drawPile.indexOf(missedId), 1)
    game.state.zones.drawPile.splice(1, 0, missedId)

    const runtime = getSkillRuntime('jianyan-sp-b39')!
    runtime.invokeActive?.(game as never, owner!.id, 'skill:jianyan-sp-b39')
    const declare = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: declare.id, playerId: owner!.id, payload: { optionId: 'red' } })

    expect(game.state.zones.drawPile).not.toContain(matchedId)
    expect(game.state.zones.drawPile).toContain(missedId)
    expect(game.state.zones.processingArea).toContain(matchedId)
    const recipientRequest = game.state.pendingRequests.at(-1)!
    expect(recipientRequest).toMatchObject({ kind: 'choose-targets', playerId: owner!.id, candidateIds: expect.arrayContaining([recipient!.id]) })
    game.respond({ requestId: recipientRequest.id, playerId: owner!.id, payload: { targetIds: [recipient!.id] } })
    expect(recipient!.zones.hand).toContain(matchedId)
    expect(game.state.zones.drawPile).toContain(missedId)
  })
})
