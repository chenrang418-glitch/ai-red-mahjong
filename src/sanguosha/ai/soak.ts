import { SanguoshaGame } from '../engine/game'
import { assertGameInvariants } from '../engine/invariants'
import { GameRng } from '../engine/rng'
import { assertCardConservation } from '../engine/zones'
import type { GameSetup } from '../engine/types'
import { emptySuspicion, observeEvent } from './belief'
import { decidePlayAction, decideResponse, type AIContext, type AIDifficulty } from './index'

/**
 * 全 AI 无头对局。
 *
 * 这是最有效的死锁探测器：任何「引擎发了一个 Request 但没人能给出合法响应」
 * 的组合，在这里都会直接卡住并被 step 上限抓出来，
 * 而不是等到真人玩到一半才发现点不下去。
 *
 * 每局都记录 seed，失败时打印出来就能精确重放。
 */

export interface SoakOptions {
  seed: string
  playerCount: number
  difficulty?: AIDifficulty
  /** 单局最多推进多少步，防止死循环把测试挂住 */
  maxSteps?: number
  /** 专项压测时固定前几个座位的武将；其余座位仍走正常随机选将。 */
  characterIds?: string[]
}

export interface SoakResult {
  seed: string
  playerCount: number
  finished: boolean
  steps: number
  turns: number
  winningCamp: string | null
  survivors: number
  /** 失败 seed 复现时直接给出阵容，避免再次插桩。 */
  characterIds: string[]
}

function setupFor(playerCount: number): GameSetup {
  return {
    mode: 'identity',
    generalChoices: 1,
    players: Array.from({ length: playerCount }, (_, index) => ({
      id: `p${index}`,
      nickname: `AI${index}`,
      isHuman: false,
    })),
  }
}

/** 跑完一局全 AI 对局。抛出的错误里一定带 seed，方便复现。 */
export function runSoakGame(options: SoakOptions): SoakResult {
  const { seed, playerCount, difficulty = 'normal', maxSteps = 20_000 } = options
  const game = new SanguoshaGame({ seed, setup: setupFor(playerCount) })
  // AI 自己的随机源和牌局随机源分开，避免 AI 的选择反过来影响洗牌序列
  const aiRng = new GameRng(`ai:${seed}`)
  const suspicion = emptySuspicion(game.viewFor('p0'))
  // 身份推断必须真的接上事件流，否则 suspicion 永远是全零
  for (const name of ['Damaged', 'Recover'] as const) {
    game.events.on(name, (context) => { observeEvent(suspicion, game.viewFor('p0'), context.event) })
  }

  const contextFor = (playerId: string): AIContext => ({
    view: game.viewFor(playerId),
    difficulty,
    rng: aiRng,
    suspicion,
  })

  const fail = (message: string, steps: number): never => {
    throw new Error(`${message}（seed=${seed} 人数=${playerCount} 步数=${steps} 回合=${game.state.turnNumber}）`)
  }

  // 选将
  game.dealGenerals()
  let guard = 0
  while (game.state.pendingRequests.length > 0) {
    if (guard++ > playerCount * 4) fail('选将没有收敛', guard)
    const request = game.state.pendingRequests[0]
    game.respond(decideResponse(contextFor(request.playerId), request))
  }
  options.characterIds?.forEach((characterId, index) => {
    if (game.state.players[index]) game.state.players[index].characterId = characterId
  })
  game.start()

  let steps = 0
  while (game.state.status === 'playing') {
    if (steps++ > maxSteps) fail('牌局没有在步数上限内结束，疑似死锁', steps)

    // 有待处理请求就先处理：这是唯一可能卡住的地方
    const request = game.state.pendingRequests[0]
    if (request) {
      const before = game.state.seq
      game.respond(decideResponse(contextFor(request.playerId), request))
      if (game.state.seq === before && game.state.pendingRequests[0]?.id === request.id) {
        fail(`Request ${request.kind} 响应后没有推进`, steps)
      }
      continue
    }

    // 出牌阶段让当前玩家决策，其余阶段直接推进
    const currentPlayer = game.state.players.find((player) => player.id === game.state.currentPlayerId)
    if (game.state.phase === 'play' && currentPlayer?.alive) {
      const playerId = game.state.currentPlayerId
      const action = decidePlayAction(contextFor(playerId), game.legalActions(playerId))
      if (action) game.act(playerId, action.id)
      else {
        const pass = game.legalActions(playerId).find((candidate) => candidate.kind === 'pass')
        if (!pass) fail('出牌阶段既没有可用动作也没有结束动作', steps)
        game.act(playerId, pass!.id)
      }
    } else {
      // 当前玩家可能在自己回合里死掉（苦肉掉到零没人救、决斗输了、自己的闪电劈到自己）。
      // 引擎正确地不给死人发动作，推进回合是驱动层的责任——
      // 联机那边由 Durable Object 的 alarm 做同一件事。
      game.advancePhase()
    }

    // 每一步都校验不变量：牌张守恒、体力合法、装备槽正确
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  }

  return {
    seed,
    playerCount,
    finished: game.state.status === 'game-over',
    steps,
    turns: game.state.turnNumber,
    winningCamp: game.state.result?.winningCamp ?? null,
    survivors: game.state.players.filter((player) => player.alive).length,
    characterIds: game.state.players.map((player) => player.characterId ?? ''),
  }
}

/** 批量跑，返回每局结果。任何一局抛错都会直接冒出来。 */
export function runSoakBatch(count: number, playerCount: number, seedPrefix = 'soak'): SoakResult[] {
  const results: SoakResult[] = []
  for (let index = 0; index < count; index += 1) {
    results.push(runSoakGame({ seed: `${seedPrefix}-${playerCount}-${index}`, playerCount }))
  }
  return results
}
