import { computed, ref, shallowRef } from 'vue'
import { SanguoshaGame } from '../engine/game'
import { GameRng } from '../engine/rng'
import type { GameRequest, GameResponse } from '../engine/requests'
import type { GameSetup } from '../engine/types'
import type { PlayerView } from '../engine/view'
import { decidePlayAction, decideResponse, isTrivialAIRequest, type AIContext, type AIDifficulty } from '../ai'
import { emptySuspicion, observeEvent, type SuspicionMap } from '../ai/belief'
import { describeEvent } from '../engine/log'
import type { GameEventName } from '../engine/events'
import { buildPresentationEvent, type PresentationEvent } from '../engine/presentation'
import { getCharacter } from '../data/characters/standard'
import { AI_PACE_MS, AI_TRIVIAL_STEP_MS, phaseDelay, playActionDelay } from '../shared/timing'

/** 会写进战报的事件。只挑对玩家有意义的，避免把每一次内部时机都刷上去。 */
const LOGGED_EVENTS: readonly GameEventName[] = [
  // PlayBegin 用来触发开局音。它不会进战报——describeEvent 没有对应分支，
  // 下面是 `if (text) pushLog(text)`，返回空就跳过；只会产生一条表现事件。
  'PlayBegin',
  'TurnStart', 'CardUsed', 'CardResponded', 'Damaged', 'Recover',
  'LoseHp', 'EnterDying', 'Death', 'JudgeResult', 'GainCard',
  'LoseEquipment',
  'SkillActivated', 'CharacterFlip', 'CardMove',
]

/**
 * 单机牌局驱动。
 *
 * **和联机共用同一个 Engine**，区别只在于「谁来提交决策」：
 * 这里由本地 AI 代替其他座位，联机那边由 Durable Object 收各家的操作。
 * 规则一份都不复制。
 *
 * AI 的节奏是纯视觉的：`aiDelayMs` 只控制 setTimeout，
 * 计算本身是同步的，不靠等待来假装思考。
 */

export interface LocalMatchOptions {
  playerCount: number
  difficulty: AIDifficulty
  /** AI 每步之间的视觉停顿；测试里设成 0 */
  aiDelayMs?: number
  seed?: string
}

const HUMAN_ID = 'p0'

function buildSetup(playerCount: number): GameSetup {
  return {
    mode: 'identity',
    /**
     * 候选武将数：**按人数平分整个武将池，上限 10**。
     *
     * 引擎的公式本来就是 `min(generalChoices, floor(池子 / 人数))`，
     * 所以这里只给上限，实际候选数始终随当前完整武将池和人数自动变化。
     * 武将池扩到 50 名才会碰到上限 10。
     */
    generalChoices: 10,
    allowHumanGeneralSelection: true,
    players: Array.from({ length: playerCount }, (_, index) => ({
      id: `p${index}`,
      nickname: index === 0 ? '你' : `电脑${index}`,
      isHuman: index === 0,
    })),
  }
}

export function useLocalSanguosha() {
  const game = shallowRef<SanguoshaGame | null>(null)
  const view = shallowRef<PlayerView | null>(null)
  const busy = ref(false)
  const error = ref('')
  const log = ref<string[]>([])
  const presentationEvents = ref<PresentationEvent[]>([])

  let aiRng = new GameRng('ai')
  let suspicion: SuspicionMap = {}
  let delayMs = 700
  let timer: number | null = null
  let generation = 0

  const myRequest = computed<GameRequest | null>(() => {
    const request = view.value?.pendingRequest
    return request && request.playerId === HUMAN_ID ? request : null
  })

  const isMyTurn = computed(() => (
    view.value?.currentPlayerId === HUMAN_ID
    && view.value?.phase === 'play'
    && !view.value?.pendingRequest
  ))

  const finished = computed(() => view.value?.status === 'game-over')

  function refresh(): void {
    if (!game.value) return
    view.value = game.value.viewFor(HUMAN_ID)
  }

  function pushLog(text: string): void {
    log.value.push(text)
    // 战报只留最近的一段，长局不会无限增长
    if (log.value.length > 60) log.value.splice(0, log.value.length - 60)
  }

  function pushPresentation(event: PresentationEvent): void {
    presentationEvents.value.push(event)
    if (presentationEvents.value.length > 30) presentationEvents.value.splice(0, presentationEvents.value.length - 30)
  }

  function contextFor(playerId: string): AIContext {
    return { view: game.value!.viewFor(playerId), difficulty: currentDifficulty, rng: aiRng, suspicion }
  }

  let currentDifficulty: AIDifficulty = 'normal'

  /** 把牌局推进到「轮到真人做决定」为止。 */
  function advanceUntilHuman(revision: number): void {
    const current = game.value
    if (!current || revision !== generation) return

    // 选将阶段也要驱动：这里原来直接 return，结果 AI 永远轮不到选将，
    // 界面就停在「其他角色选将中…」不动。
    if (current.state.status === 'choosing-general') {
      const pending = current.state.pendingRequests[0]
      if (!pending) {
        step(revision, () => { current.start() }, 'phase')
        return
      }
      if (pending.playerId === HUMAN_ID) { busy.value = false; refresh(); return }
      // 选将走短间隔：这一步没有任何动画，8 人局按正常节奏要等十几秒
      // 才开得了局，玩家只能盯着「其他角色选将中…」。
      step(revision, () => { current.respond(decideResponse(contextFor(pending.playerId), pending)) }, 'instant')
      return
    }

    if (current.state.status !== 'playing') { refresh(); return }

    const request = current.state.pendingRequests[0]
    if (request) {
      if (request.playerId === HUMAN_ID) { busy.value = false; refresh(); return }
      step(revision, () => { current.respond(decideResponse(contextFor(request.playerId), request)) }, isTrivialAIRequest(request) ? 'instant' : 'normal')
      return
    }

    const currentPlayer = current.state.players.find((player) => player.id === current.state.currentPlayerId)
    if (current.state.phase === 'play' && currentPlayer?.alive) {
      if (current.state.currentPlayerId === HUMAN_ID) { busy.value = false; refresh(); return }
      const playerId = current.state.currentPlayerId
      const actions = current.legalActions(playerId)
      const onlyPass = actions.every((candidate) => candidate.kind === 'pass')
      step(revision, () => {
        const action = decidePlayAction(contextFor(playerId), actions)
        if (action) current.act(playerId, action.id)
        else {
          const pass = actions.find((candidate) => candidate.kind === 'pass')
          if (pass) current.act(playerId, pass.id)
        }
      }, onlyPass ? 'instant' : 'play')
      return
    }

    // 当前角色可能已经死了（苦肉、决斗、自己的闪电），回合要收束
    step(revision, () => { current.advancePhase() }, 'phase')
  }

  /** 执行一步，带视觉停顿；出错时把牌局停在原地并报出来，不静默吞掉。 */
  function step(revision: number, action: () => void, pace: 'normal' | 'play' | 'phase' | 'instant' = 'normal'): void {
    busy.value = true
    const run = () => {
      if (revision !== generation) return
      try {
        action()
        refresh()
        advanceUntilHuman(revision)
      } catch (cause) {
        busy.value = false
        error.value = cause instanceof Error ? cause.message : String(cause)
      }
    }
    /**
     * 自动阶段（判定、弃牌、阶段流转）以前封顶 320ms。
     *
     * 但**判定就是走这条路**：翻牌、看花色、结算全在这 320ms 里过完，
     * 用户报「还没看清就判定结束了」，根因在这个封顶，不在 AI 间隔。
     * 改成跟随整体节奏的一半，最少 700ms——够看清判定牌的花色点数，
     * 又不会让纯粹的阶段流转拖沓。
     *
     * 选将、只能放弃的响应和没有牌可出的出牌阶段没有可观察决策，压到 60ms；
     * 自动阶段推进只留 180～360ms。
     *
     * `play` 是 AI 主动出牌，比 `normal`（响应牌）明显慢——响应牌是被动接话，
     * 放慢它只会让人干等；看不清的是主动出牌那一下。
     */
    const visualDelay = delayMs <= 0 ? 0
      : pace === 'instant' ? AI_TRIVIAL_STEP_MS
        : pace === 'phase' ? phaseDelay(delayMs)
          : pace === 'play' ? playActionDelay(delayMs)
            : delayMs
    if (visualDelay <= 0) run()
    else timer = window.setTimeout(run, visualDelay)
  }

  function start(options: LocalMatchOptions): void {
    generation += 1
    if (timer !== null) window.clearTimeout(timer)
    error.value = ''
    log.value = []
    presentationEvents.value = []
    delayMs = options.aiDelayMs ?? AI_PACE_MS.normal
    currentDifficulty = options.difficulty
    const seed = options.seed ?? `local-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
    aiRng = new GameRng(`ai:${seed}`)

    const created = new SanguoshaGame({ seed, setup: buildSetup(options.playerCount) })
    // 战报订阅引擎事件，界面不自己推断发生了什么。
    // describeEvent 已经按观看者过滤：别人摸到什么牌不会写进来。
    for (const name of LOGGED_EVENTS) {
      created.events.on(name, (context) => {
        const text = describeEvent(created.state, context.event, HUMAN_ID)
        if (text) pushLog(text)
        const presentation = buildPresentationEvent(created.state, context.event)
        if (presentation) pushPresentation(presentation)
      })
    }
    game.value = created
    suspicion = emptySuspicion(created.viewFor(HUMAN_ID))
    // 身份推断同样要接事件流，单机 AI 才会随着局势改变目标
    for (const name of ['Damaged', 'Recover'] as const) {
      created.events.on(name, (context) => { observeEvent(suspicion, created.viewFor(HUMAN_ID), context.event) })
    }
    created.dealGenerals()
    applyDevLineup(created)
    refresh()
    pushLog(`牌局开始，${options.playerCount} 人身份局`)
    advanceUntilHuman(generation)
  }

  /**
   * 开发环境专用：用 `?lineup=caocao,lvbu,…` 指定整桌武将。
   *
   * 立绘、座位布局这类 UI 要对着**特定几个武将**看效果，而正常开局是随机发候选，
   * 靠反复重开去凑齐指定阵容不现实。这里只改 `characterId` 并把选将请求消掉，
   * 不碰引擎规则、PlayerView 和联机协议；`import.meta.env.DEV` 保证它不进生产构建。
   */
  function applyDevLineup(created: SanguoshaGame): void {
    if (!import.meta.env.DEV) return
    const raw = new URLSearchParams(window.location.search).get('lineup')
    if (!raw) return
    const wanted = raw.split(',').map((id) => id.trim()).filter(Boolean)
    created.state.players.forEach((player, index) => {
      const characterId = wanted[index]
      if (!characterId) return
      const character = getCharacter(characterId)
      if (!character) return
      player.characterId = characterId
      player.maxHp = character.maxHp + (player.identity === 'lord' ? 1 : 0)
      player.hp = player.maxHp
      // 技能触发器在构造时已按事件全局注册，运行时按当前 characterId 查表，
      // 这里换将不需要重新注册
    })
    created.state.pendingRequests = created.state.pendingRequests.filter((request) => request.kind !== 'choose-general')
    if (!created.state.pendingRequests.length && created.state.status === 'choosing-general') created.start()
  }

  /** 真人提交一次响应。 */
  function respond(response: GameResponse): void {
    const current = game.value
    if (!current) return
    try {
      current.respond(response)
      error.value = ''
      refresh()
      advanceUntilHuman(generation)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  /** 真人出牌阶段执行一个动作。 */
  function act(actionId: string): void {
    const current = game.value
    if (!current) return
    try {
      current.act(HUMAN_ID, actionId)
      error.value = ''
      refresh()
      advanceUntilHuman(generation)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  /** 选将全部完成后开局。 */
  function beginPlaying(): void {
    const current = game.value
    if (!current) return
    try {
      current.start()
      refresh()
      advanceUntilHuman(generation)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function abandon(): void {
    generation += 1
    if (timer !== null) window.clearTimeout(timer)
    game.value = null
    view.value = null
    presentationEvents.value = []
    busy.value = false
    error.value = ''
  }

  const legalActions = computed(() => (isMyTurn.value ? view.value?.legalActions ?? [] : []))

  return { view, busy, error, log, presentationEvents, myRequest, isMyTurn, finished, legalActions, start, respond, act, beginPlaying, abandon }
}
