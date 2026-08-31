import { createRulesetV1Deck } from '../data/ruleset-v1/deck'
import { resolveDamage, resolveRescueResponse, resumeDamageChain, type DamageOptions } from './damage'
import { GameEventBus, type EventContext, type GameEvent, type GameEventName } from './events'
import { identitiesFor } from './modes/identity'
import { GameRng } from './rng'
import { startPlaying } from './turn'
import { advanceGamePhase, resolveDiscardPhaseResponse } from './phase'
import { legalPlayActions, performPlayAction, resolveCardPickResponse, resolveCardResponse, resumeCardResolution } from './cards/basic'
import { resolveBorrowedKnifeTarget } from './cards/tricks'
import { resolveJudgmentResponse, resumeJudgment } from './judgment'
import { emptyEquipment, RULESET_VERSION, type GameSetup, type PlayerState, type SanguoshaState } from './types'
import type { GameResponse } from './requests'
import { validateResponse } from './requests'
import { allCharacterIds, getCharacter, skillIdsOf } from '../data/characters/standard'
import { registerSkillTriggers } from './skills/runtime'
import { buildPlayerView } from './view'

export interface SanguoshaGameOptions {
  seed: string
  setup: GameSetup
}

export class SanguoshaGame {
  readonly rng: GameRng
  readonly events = new GameEventBus()
  readonly state: SanguoshaState

  constructor(options: SanguoshaGameOptions) {
    const { setup, seed } = options
    if (!seed.trim()) throw new Error('seed 不能为空')
    if (new Set(setup.players.map((player) => player.id)).size !== setup.players.length) throw new Error('玩家 id 必须唯一')
    const identities = identitiesFor(setup.players.length)
    this.rng = new GameRng(`${RULESET_VERSION}:${seed}`)
    const assigned = this.rng.shuffle(identities)
    const deck = this.rng.shuffle(createRulesetV1Deck())
    const cards = Object.fromEntries(deck.map((card) => [card.id, card]))
    const players: PlayerState[] = setup.players.map((player, seat) => ({
      ...player,
      seat,
      alive: true,
      identity: assigned[seat],
      identityRevealed: assigned[seat] === 'lord',
      characterId: null,
      hp: 4,
      maxHp: 4,
      chained: false,
      faceDown: false,
      zones: { hand: [], equipment: emptyEquipment(), judgingArea: [] },
      marks: {},
      usedLimitedSkills: [],
      distanceFromOthers: 0,
      distanceToOthers: 0,
      attackRangeBonus: 0,
    }))
    const drawPile = deck.map((card) => card.id)
    const lord = players.find((player) => player.identity === 'lord')!
    this.state = {
      rulesetVersion: RULESET_VERSION,
      seed,
      setup: structuredClone(setup),
      seq: 0,
      status: 'choosing-general',
      players,
      cards,
      zones: { drawPile, discardPile: [], processingArea: [] },
      currentPlayerId: lord.id,
      turnNumber: 0,
      phase: 'prepare',
      skippedPhases: [],
      turnUsage: { slashUses: 0, wineUses: 0, wineDamageBonus: 0 },
      pendingRequests: [],
      dying: null,
      damageChain: null,
      judgment: null,
      cardResolution: null,
      decisions: [],
      result: null,
    }
    // 技能触发器是运行时代码，不进 GameState。DO 恢复后必须重新调用这里。
    registerSkillTriggers(this, (event, handler, priority) => { this.events.on(event, handler, priority) }, skillIdsOf)
    this.emit('GameStart', { playerCount: players.length })
  }

  emit(name: GameEventName, payload: Record<string, unknown> = {}): GameEvent {
    return this.dispatch(name, payload).event
  }

  dispatch(
    name: GameEventName,
    payload: Record<string, unknown> = {},
    metadata: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'> = {},
  ): EventContext {
    const seq = ++this.state.seq
    const event: GameEvent = { id: `event-${seq}`, seq, name, payload, ...metadata }
    return this.events.emit(event)
  }

  damage(options: DamageOptions): void {
    resolveDamage(this, options)
  }

  respond(response: GameResponse): void {
    const request = this.state.pendingRequests.find((candidate) => candidate.id === response.requestId)
    if (!request) throw new Error('Request 不存在或已经处理')
    if (request.kind === 'rescue') {
      resolveRescueResponse(this, request, response)
      if (!this.state.dying) {
        resumeDamageChain(this)
        if (!this.state.dying && !this.state.damageChain) {
          resumeJudgment(this)
          if (!this.state.judgment) resumeCardResolution(this)
        }
      }
      return
    }
    if (request.kind === 'respond-card') {
      if (this.state.judgment?.stage === 'awaiting-nullification' && this.state.judgment.requestId === request.id) {
        resolveJudgmentResponse(this, request, response)
      } else resolveCardResponse(this, request, response)
      return
    }
    if (request.kind === 'choose-general') {
      const validationError = validateResponse(request, response)
      if (validationError) throw new Error(validationError)
      const characterId = (response.payload as { characterId: string }).characterId
      const character = getCharacter(characterId)
      if (!character) throw new Error('武将不存在')
      const player = this.state.players.find((candidate) => candidate.id === response.playerId)!
      player.characterId = characterId
      // 主公体力上限 +1 是身份局的规则，写在模式层而不是武将数据里
      player.maxHp = character.maxHp + (player.identity === 'lord' && this.state.players.length >= 5 ? 1 : 0)
      player.hp = player.maxHp
      this.state.pendingRequests = this.state.pendingRequests.filter((candidate) => candidate.id !== request.id)
      this.state.decisions.push({
        index: this.state.decisions.length,
        requestId: request.id,
        playerId: response.playerId,
        kind: request.kind,
        payload: structuredClone(response.payload),
      })
      return
    }
    if (request.kind === 'choose-cards' && request.purpose === 'discard-phase') {
      resolveDiscardPhaseResponse(this, request, response)
      return
    }
    // 锦囊效果里的选牌：拆桥 / 顺手 / 五谷 / 火攻
    if (request.kind === 'choose-cards' && request.purpose === 'card-effect') {
      resolveCardPickResponse(this, request, response)
      return
    }
    // 借刀杀人：目标挑选自己那张【杀】的受害者
    if (request.kind === 'choose-targets' && this.state.cardResolution?.kind === 'trick') {
      resolveBorrowedKnifeTarget(this, request, response)
      return
    }
    throw new Error(`暂不支持处理 Request：${request.kind}`)
  }

  advancePhase(): void {
    advanceGamePhase(this)
  }

  legalActions(playerId: string) {
    return legalPlayActions(this.state, playerId)
  }

  act(playerId: string, actionId: string): void {
    performPlayAction(this, playerId, actionId)
  }

  /**
   * 给每名玩家发候选武将并生成选将 Request。
   *
   * 候选池从同一个 RNG 里取，所以相同 seed 得到相同候选，回放对得上。
   * 候选之间不重复：同一个武将不会同时出现在两个人的备选里。
   */
  dealGenerals(): void {
    if (this.state.status !== 'choosing-general') throw new Error('牌局不在选将阶段')
    if (this.state.pendingRequests.length > 0) throw new Error('选将已经发起')
    const pool = this.rng.shuffle(allCharacterIds())
    // 每个人的候选互不重叠，所以武将总数必须够分。不够就直接报错，
    // 不能静默给最后一个人发一份空候选——那会变成他永远选不了将。
    if (pool.length < this.state.players.length) {
      throw new Error(`已实现的武将只有 ${pool.length} 个，不足 ${this.state.players.length} 人局分配`)
    }
    const perPlayer = Math.max(1, Math.min(this.state.setup.generalChoices, Math.floor(pool.length / this.state.players.length)))
    this.state.players.forEach((player, index) => {
      const candidates = pool.slice(index * perPlayer, (index + 1) * perPlayer)
      this.state.pendingRequests.push({
        id: `request-general-${player.id}`,
        kind: 'choose-general',
        playerId: player.id,
        prompt: '选择你的武将',
        timeoutMs: 60_000,
        optional: false,
        candidates,
        min: 1,
        max: 1,
      })
    })
  }

  /** 选将完成后调用；起始手牌在此刻发放，避免选将阶段提前持有私密手牌。 */
  start(): void {
    if (this.state.status !== 'choosing-general') throw new Error('牌局不在选将阶段')
    if (this.state.pendingRequests.some((request) => request.kind === 'choose-general')) throw new Error('还有玩家没有选将')
    if (this.state.players.some((player) => player.zones.hand.length > 0)) throw new Error('起始手牌已经发放')
    for (let round = 0; round < 4; round += 1) {
      for (const player of this.state.players) player.zones.hand.push(this.state.zones.drawPile.shift()!)
    }
    startPlaying(this.state, (name, payload) => { this.emit(name, payload) })
  }

  viewFor(playerId: string) {
    return buildPlayerView(this.state, playerId)
  }

  replayRecord() {
    return {
      rulesetVersion: this.state.rulesetVersion,
      seed: this.state.seed,
      setup: structuredClone(this.state.setup),
      decisions: structuredClone(this.state.decisions),
    }
  }
}
