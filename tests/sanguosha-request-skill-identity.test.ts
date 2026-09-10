import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { GameRng } from '@/sanguosha/engine/rng'
import { decidePlayAction, decideResponse } from '@/sanguosha/ai/index'
import { emptySuspicion } from '@/sanguosha/ai/belief'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import type { GameSetup } from '@/sanguosha/engine/types'

/**
 * 技能发出的请求**必须带着技能身份**（`skillId` / `skillStep`）。
 *
 * 这是给 AI 用的：原来 `ai/index.ts` 里全是
 * `request.prompt.startsWith('【巧变】：获得至多')` 这样的分支——
 * 改一个字 AI 就静默降级到通用兜底，而且**没有任何测试会红**。
 *
 * 这份测试就是那道红线：以后新增技能忘了走 `askSkill`（或者群体决定
 * 忘了传 `skillId`），跑一遍压测就会在这里被抓住。
 */

/** 技能挂起产生的请求，id 都以这个前缀开头（见 `Game.askSkill`）。 */
const SKILL_REQUEST_PREFIX = 'request-skill-'

interface Seen {
  total: number
  missing: string[]
  skills: Set<string>
}

/** 跑一局随机对局，检查每一条技能请求有没有带身份。 */
function auditGame(seed: string, playerCount: number, characterIds?: string[]): Seen {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: playerCount }, (_, index) => ({ id: `p${index}`, nickname: `AI${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  if (characterIds) {
    game.state.players.forEach((player, index) => { player.characterId = characterIds[index % characterIds.length] })
  }
  const aiRng = new GameRng(`ai:${seed}`)
  const suspicion = emptySuspicion(game.viewFor('p0'))
  const context = (playerId: string) => ({ view: game.viewFor(playerId), difficulty: 'normal' as const, rng: aiRng, suspicion })

  const seen: Seen = { total: 0, missing: [], skills: new Set() }
  const inspect = (): void => {
    for (const request of game.state.pendingRequests) {
      if (!request.id.startsWith(SKILL_REQUEST_PREFIX)) continue
      seen.total += 1
      if (request.skillId) seen.skills.add(request.skillId)
      else seen.missing.push(`${request.kind}|${request.prompt.slice(0, 24)}`)
    }
  }

  if (!characterIds) game.dealGenerals()
  let guard = 0
  while (game.state.pendingRequests.length > 0) {
    if (guard++ > playerCount * 4) break
    const request = game.state.pendingRequests[0]
    game.respond(decideResponse(context(request.playerId), request))
  }
  game.start()

  for (let steps = 0; steps < 4_000 && game.state.status === 'playing'; steps += 1) {
    inspect()
    const request = game.state.pendingRequests[0]
    if (request) {
      game.respond(decideResponse(context(request.playerId), request))
      continue
    }
    const current = game.state.players.find((player) => player.id === game.state.currentPlayerId)
    if (game.state.phase === 'play' && current?.alive) {
      const action = decidePlayAction(context(current.id), game.legalActions(current.id))
      game.act(current.id, action?.id ?? game.legalActions(current.id).find((candidate) => candidate.kind === 'pass')!.id)
    } else game.advancePhase()
  }
  inspect()
  return seen
}

describe('技能请求必须带技能身份', () => {
  it('随机对局里每一条技能请求都有 skillId', () => {
    const seen: Seen = { total: 0, missing: [], skills: new Set() }
    for (let index = 0; index < 12; index += 1) {
      const round = auditGame(`identity-${index}`, 5 + (index % 4))
      seen.total += round.total
      seen.missing.push(...round.missing)
      for (const skill of round.skills) seen.skills.add(skill)
    }
    expect(seen.total, '样本里确实出现过技能请求').toBeGreaterThan(20)
    expect(seen.skills.size, '而且覆盖到不止一两个技能').toBeGreaterThan(5)
    expect(
      seen.missing,
      `这些技能请求没有带 skillId（AI 认不出来，只能落通用兜底）：\n${[...new Set(seen.missing)].slice(0, 20).join('\n')}`,
    ).toEqual([])
  }, 300_000)

  it('一将成名 2012 全 12 人同样带得齐', () => {
    /*
     * 最新一批武将单独再验一遍：新写的技能最容易漏，
     * 而随机阵容里它们被抽中的概率低。
     */
    const cast = [
      'caozhang', 'zhonghui', 'xunyou', 'wangyi',
      'liaohua', 'guanxingzhangbao', 'madai', 'chengpu',
      'handang', 'bulianshi', 'liubiao', 'huaxiong',
    ]
    const missing: string[] = []
    let total = 0
    for (let index = 0; index < 12; index += 1) {
      const rotated = Array.from({ length: 8 }, (_, offset) => cast[(index + offset) % cast.length])
      const round = auditGame(`identity-yjcm12-${index}`, 8, rotated)
      total += round.total
      missing.push(...round.missing)
    }
    expect(total, '这一批确实发过技能请求').toBeGreaterThan(20)
    expect(missing, `这些没带 skillId：\n${[...new Set(missing)].slice(0, 20).join('\n')}`).toEqual([])
  }, 300_000)

  it('非技能请求不该被误标上技能身份', () => {
    /*
     * 反证。没有这一条的话，「全都带 skillId」可以靠给**所有**请求
     * 硬塞一个值来满足——那就不是身份，是噪声。
     */
    const setup: GameSetup = {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `AI${index}`, isHuman: false })),
    }
    const game = new SanguoshaGame({ seed: 'identity-negative', setup })
    game.dealGenerals()
    const general = game.state.pendingRequests[0]
    expect(general.kind, '前提：这是选将请求').toBe('choose-general')
    expect(general.skillId, '选将不是技能发的，不该有 skillId').toBeUndefined()
  })

  it('武将表里每个技能 id 都能对上一个运行时（AI 按 id 匹配的前提）', () => {
    /*
     * AI 改成按 `skillId` 匹配之后，技能 id 就成了一份**契约**。
     * 这一条确保武将表和运行时注册表不会各说各话。
     */
    const orphan: string[] = []
    for (const character of ALL_CHARACTERS) {
      for (const skill of character.skills) {
        if (!skill.id.trim()) orphan.push(`${character.name} 有一个空技能 id`)
      }
    }
    expect(orphan).toEqual([])
  })
})
