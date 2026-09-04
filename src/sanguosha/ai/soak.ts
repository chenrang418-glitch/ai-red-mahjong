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
  /**
   * 这一局里各类机制出现了多少次。
   *
   * 专项压测要回答的是「这个技能真的被跑到了吗」——只看「600 局都没崩」
   * 是证明不了的：AI 一次都没发动的技能同样不会崩。计数器是**通用**的，
   * 按 `skill:<技能id>` / `card:<牌名>` / `viewas:<牌名>` / `skip:<阶段>` 归类，
   * 加新武将不需要再改这里。
   */
  counters: Record<string, number>
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

  const counters: Record<string, number> = {}
  const bump = (key: string, amount = 1): void => { counters[key] = (counters[key] ?? 0) + amount }
  game.events.on('SkillActivated', (context) => {
    const skillId = (context.event.payload as { skillId?: unknown }).skillId
    if (typeof skillId === 'string') bump(`skill:${skillId}`)
  })
  game.events.on('CardUsed', (context) => {
    const cardName = (context.event.payload as { cardName?: unknown }).cardName
    if (typeof cardName === 'string') bump(`card:${cardName}`)
  })
  game.events.on('Recover', (context) => {
    const amount = (context.event.payload as { amount?: unknown }).amount
    bump('recover', typeof amount === 'number' ? amount : 1)
  })
  // 阶段跳过没有自己的事件；skippedPhases 每回合开始会被清空，
  // 所以在回合结束时读一次是唯一不漏的时机。
  game.events.on('TurnEnd', () => {
    for (const phase of game.state.skippedPhases) bump(`skip:${phase}`)
  })

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
  const recentSteps: string[] = []
  const remember = (entry: string): void => {
    recentSteps.push(entry)
    if (recentSteps.length > 12) recentSteps.shift()
  }
  while (game.state.status === 'playing') {
    if (steps++ > maxSteps) fail(`牌局没有在步数上限内结束，疑似死锁；最近步骤：${recentSteps.join(' -> ')}`, steps)

    // 有待处理请求就先处理：这是唯一可能卡住的地方
    const request = game.state.pendingRequests[0]
    if (request) {
      remember(`request:${request.kind}:${request.playerId}`)
      const before = game.state.seq
      const response = decideResponse(contextFor(request.playerId), request)
      try {
        game.respond(response)
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        fail(`${reason}；请求=${JSON.stringify(request)}；响应=${JSON.stringify(response)}`, steps)
      }
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
      if (action) {
        remember(`action:${action.id}:${playerId}`)
        /*
         * 转化技产出的动作单独记一笔：CardUsed 只看得到「用了一张兵粮寸断」，
         * 分不出这张是实体牌还是断粮换来的。
         *
         * 不能只认 `play:viewas:` 前缀——那只有延时锦囊那一支才会加。
         * 转化成基本牌时（董卓【酒池】把黑桃当酒）动作 id 和用实体牌完全一样，
         * 所以真正可靠的判据是「实体牌的名字和这次使用的牌名对不上」。
         */
        if (action.kind === 'use-card') {
          const printed = game.state.cards[action.cardIds[0]]?.name
          if (action.asCardName && printed && printed !== action.asCardName) bump(`viewas:${action.asCardName}`)
        }
        const before = game.state.seq
        game.act(playerId, action.id)
        if (game.state.seq === before && game.legalActions(playerId).some((candidate) => candidate.id === action.id)) {
          fail(`Action ${action.id} 执行后没有推进`, steps)
        }
      }
      else {
        const pass = game.legalActions(playerId).find((candidate) => candidate.kind === 'pass')
        if (!pass) fail('出牌阶段既没有可用动作也没有结束动作', steps)
        remember(`action:${pass!.id}:${playerId}`)
        game.act(playerId, pass!.id)
      }
    } else {
      // 当前玩家可能在自己回合里死掉（苦肉掉到零没人救、决斗输了、自己的闪电劈到自己）。
      // 引擎正确地不给死人发动作，推进回合是驱动层的责任——
      // 联机那边由 Durable Object 的 alarm 做同一件事。
      remember(`advance:${game.state.phase}:${game.state.currentPlayerId}`)
      game.advancePhase()
    }

    // 每一步都校验不变量：牌张守恒、体力合法、装备槽正确
    try {
      assertCardConservation(game.state)
      assertGameInvariants(game.state)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      const hp = game.state.players.map((player) => `${player.id}:${player.hp}/${player.maxHp}:${player.alive ? 'alive' : 'dead'}`).join(',')
      fail(`${reason}；最近步骤=${recentSteps.join(' -> ')}；体力=${hp}`, steps)
    }
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
    counters,
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
