import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { GameRng } from '@/sanguosha/engine/rng'
import { decidePlayAction, decideResponse } from '@/sanguosha/ai/index'
import { emptySuspicion } from '@/sanguosha/ai/belief'
import { buildPresentationEvent, type PresentationEvent } from '@/sanguosha/engine/presentation'
import type { GameEventName, GameSetup } from '@/sanguosha/engine/types'

/**
 * 技能横幅不会连播两遍。
 *
 * 用户报「很多角色使用技能时，中央动画重复显示两次」。根因有两条：
 *
 * 1. 引擎在技能**每一步**得到肯定回答时都会补一条 SkillActivated 兜底，
 *    而多步技能（选牌 → 选目标 → 选选项）一次发动要走好几步；
 * 2. 有些技能自己也播横幅，和兜底那条撞在一起。
 *
 * 这里跑整局，按**玩家真正看到的文案**检查：牌桌中央不该出现两条挨着的、
 * 一模一样的技能横幅。测的是表现层的输出，不碰任何规则。
 */

const EVENT_NAMES: GameEventName[] = [
  'GameStart', 'TurnStart', 'TurnEnd', 'PhaseStart', 'PhaseEnd',
  'BeforeCardUse', 'CardUsed', 'TargetSpecified', 'TargetConfirmed', 'CardResolved', 'AfterCardUse',
  'CardResponded', 'BeforeDamage', 'DamageCaused', 'DamageInflicted', 'Damaged', 'AfterDamage',
  'SkillActivated', 'CharacterFlip', 'Recover', 'LoseHp',
  'LoseEquipment', 'EnterDying', 'QuitDying', 'BeforeDeath', 'Death',
  'CardMove', 'LoseCard', 'GainCard', 'JudgeStart', 'JudgeResult', 'JudgeEnd',
]

/** 跑完一局，返回相邻重复的技能横幅描述。 */
function repeatedBanners(seed: string, playerCount: number): string[] {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: playerCount }, (_, index) => ({ id: `p${index}`, nickname: `AI${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const aiRng = new GameRng(`ai:${seed}`)
  const suspicion = emptySuspicion(game.viewFor('p0'))
  const context = (playerId: string) => ({ view: game.viewFor(playerId), difficulty: 'normal' as const, rng: aiRng, suspicion })

  const repeated: string[] = []
  let previous: PresentationEvent | null = null
  for (const name of EVENT_NAMES) {
    game.events.on(name, (handled) => {
      const event = buildPresentationEvent(game.state, handled.event)
      if (!event) return
      if (event.kind === 'skill' && previous?.kind === 'skill'
        && previous.text === event.text && previous.sourceId === event.sourceId) {
        repeated.push(`${seed}: ${event.text}`)
      }
      previous = event
    })
  }

  game.dealGenerals()
  let guard = 0
  while (game.state.pendingRequests.length > 0) {
    if (guard++ > playerCount * 4) throw new Error('选将没有收敛')
    const request = game.state.pendingRequests[0]
    game.respond(decideResponse(context(request.playerId), request))
  }
  game.start()

  let steps = 0
  while (game.state.status === 'playing') {
    if (steps++ > 20_000) throw new Error(`死锁 seed=${seed}`)
    const request = game.state.pendingRequests[0]
    if (request) { game.respond(decideResponse(context(request.playerId), request)); continue }
    const current = game.state.players.find((player) => player.id === game.state.currentPlayerId)
    if (game.state.phase === 'play' && current?.alive) {
      const action = decidePlayAction(context(current.id), game.legalActions(current.id))
      if (action) game.act(current.id, action.id)
      else game.act(current.id, game.legalActions(current.id).find((candidate) => candidate.kind === 'pass')!.id)
    } else game.advancePhase()
  }
  return repeated
}

describe('技能横幅', () => {
  it('整局跑下来没有一条技能横幅连播两遍', () => {
    const repeated: string[] = []
    for (let index = 0; index < 30; index += 1) {
      repeated.push(...repeatedBanners(`banner-${index}`, 5 + (index % 4)))
    }
    expect(repeated, `牌桌中央出现了重复横幅：\n${repeated.slice(0, 10).join('\n')}`).toEqual([])
  }, 300_000)

  it('技能仍然会播横幅——不是把横幅全关掉了', () => {
    const setup: GameSetup = {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `AI${index}`, isHuman: false })),
    }
    const game = new SanguoshaGame({ seed: 'banner-alive', setup })
    const aiRng = new GameRng('ai:banner-alive')
    const suspicion = emptySuspicion(game.viewFor('p0'))
    const context = (playerId: string) => ({ view: game.viewFor(playerId), difficulty: 'normal' as const, rng: aiRng, suspicion })
    let banners = 0
    game.events.on('SkillActivated', (handled) => {
      if (buildPresentationEvent(game.state, handled.event)?.kind === 'skill') banners += 1
    })

    game.dealGenerals()
    while (game.state.pendingRequests.length > 0) {
      const request = game.state.pendingRequests[0]
      game.respond(decideResponse(context(request.playerId), request))
    }
    game.start()
    let steps = 0
    while (game.state.status === 'playing' && steps++ < 20_000) {
      const request = game.state.pendingRequests[0]
      if (request) { game.respond(decideResponse(context(request.playerId), request)); continue }
      const current = game.state.players.find((player) => player.id === game.state.currentPlayerId)
      if (game.state.phase === 'play' && current?.alive) {
        const action = decidePlayAction(context(current.id), game.legalActions(current.id))
        if (action) game.act(current.id, action.id)
        else game.act(current.id, game.legalActions(current.id).find((candidate) => candidate.kind === 'pass')!.id)
      } else game.advancePhase()
    }
    expect(banners, '一整局一条技能横幅都没有，说明修过头了').toBeGreaterThan(0)
  }, 120_000)
})
