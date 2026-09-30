import { computed, ref, shallowRef } from 'vue'
import { SanguoshaGame } from '../engine/game'
import { GameRng } from '../engine/rng'
import type { GameRequest, GameResponse } from '../engine/requests'
import type { GameSetup } from '../engine/types'
import type { PlayerView } from '../engine/view'
import type { AIContext, AIDifficulty } from '../ai'
import type { SuspicionMap } from '../ai/belief'
import { describeEvent } from '../engine/log'
import type { GameEventName } from '../engine/events'
import { buildPresentationEvent, type PresentationEvent } from '../engine/presentation'
import { getCharacter } from '../data/characters/standard'
import { AI_PACE_MS, AI_TRIVIAL_STEP_MS, phaseDelay, playActionDelay } from '../shared/timing'
import { timeoutDefaultResponse } from '../engine/timeout-default'
import type { SgsSeatTimer as SgsSeatTimerData, SgsTimerKind } from '../online/protocol'

/** 和联机默认的操作时间对齐（`DEFAULT_TURN_SECONDS`，见 online/protocol.ts）。 */
const DEFAULT_TURN_SECONDS = 30
/** 选将固定给足时间读技能文本，和联机的 `PICK_GENERAL_WINDOW_MS` 一致。 */
const PICK_GENERAL_WINDOW_MS = 60_000
/** 连续这么多次没在窗口内操作就自动转托管，和联机的 `AUTO_TRUSTEE_TIMEOUTS` 一致。 */
const AUTO_TRUSTEE_TIMEOUTS = 3

/** 这一步在等谁：请求本人，或者没有请求时轮到出牌的那个人。 */
interface WaitingSlot {
  playerId: string
  request: GameRequest | null
}

/**
 * 这一步该画成哪种计时条。逻辑和服务端 `timerKindOf` 一致（那边给联机房间用，
 * 这里给单机用，两处各自独立维护而不是共享一份代码——单机不该反向依赖
 * `server/`，那边还有 Durable Object 相关的运行时假设）。
 */
export function timerKindOf(status: string, request: GameRequest | null): SgsTimerKind {
  if (status === 'choosing-general' || request?.kind === 'choose-general') return 'pick-general'
  if (!request) return 'action'
  if (request.kind === 'respond-card' && request.requiredCardName === '无懈可击') return 'claim'
  return 'response'
}

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
  /** 每步操作的倒计时秒数，默认对齐联机默认值；测试可以调大避免误触发。 */
  turnSeconds?: number
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
  const trustee = ref(false)
  const error = ref('')
  const log = ref<string[]>([])
  const presentationEvents = ref<PresentationEvent[]>([])
  /** 当前正在被等待的座位计时，形状和联机 `SgsRoomView.timers` 一致，牌桌组件不用分两套。 */
  const timers = ref<SgsSeatTimerData[]>([])

  let aiRng = new GameRng('ai')
  let suspicion: SuspicionMap = {}
  let delayMs = 700
  let timer: number | null = null
  let timerOwner: string | null = null
  let generation = 0
  let aiModule: typeof import('../ai') | null = null
  let beliefModule: typeof import('../ai/belief') | null = null
  let turnSecondsValue = DEFAULT_TURN_SECONDS
  /** 真人这一步的强制超时定时器；只有真人自己的等待才会真正执行超时动作。 */
  let humanTimeoutTimer: number | null = null
  /** 当前这份计时对应哪一次等待——请求 id，或者「这个回合这个人」。换了就重新起表。 */
  let waitingKey = ''
  let waitingStartedAt = 0
  /** 连续多少次真人超时没操作；达到阈值自动转托管，操作一次就清零。 */
  let humanTimeoutStreak = 0

  async function loadLocalAI(): Promise<void> {
    if (aiModule && beliefModule) return
    ;[aiModule, beliefModule] = await Promise.all([import('../ai'), import('../ai/belief')])
  }

  const myRequest = computed<GameRequest | null>(() => {
    if (trustee.value) return null
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
    updateTimer()
  }

  /** 现在这一步在等谁：有请求就是请求本人，没有请求就是轮到出牌的那个人。 */
  function currentWaitingSlot(): WaitingSlot | null {
    const state = game.value?.state
    if (!state) return null
    if (state.status === 'choosing-general') {
      const pending = state.pendingRequests[0]
      return pending ? { playerId: pending.playerId, request: pending } : null
    }
    if (state.status !== 'playing') return null
    const request = state.pendingRequests[0]
    if (request) return { playerId: request.playerId, request }
    const currentPlayer = state.players.find((candidate) => candidate.id === state.currentPlayerId)
    if (state.phase === 'play' && currentPlayer?.alive) return { playerId: state.currentPlayerId, request: null }
    return null
  }

  /**
   * 这一步的名义窗口有多长。口径和联机 `nominalWindowMs` 一致：
   * 选将固定 60 秒，无懈可击这类抢答按请求自带的窗口（但不超过设置的操作时间），
   * 其余用设置的操作时间。
   */
  function nominalWindowMs(request: GameRequest | null): number {
    if (request?.kind === 'choose-general') return PICK_GENERAL_WINDOW_MS
    if (request?.kind === 'choose-option' && request.interaction?.kind === 'waterwheel') return request.timeoutMs
    if (request?.kind === 'respond-card' && request.requiredCardName === '无懈可击') {
      return Math.min(turnSecondsValue * 1000, request.timeoutMs)
    }
    return turnSecondsValue * 1000
  }

  function clearHumanTimeoutTimer(): void {
    if (humanTimeoutTimer !== null) { window.clearTimeout(humanTimeoutTimer); humanTimeoutTimer = null }
  }

  /**
   * 按当前等待的座位重新计算 `timers`，需要的话（真人自己在等且没有托管）
   * 挂一个真正会执行的超时定时器。
   *
   * **同一次等待的表不会被拨回起点**：`waitingKey` 没变就沿用 `waitingStartedAt`，
   * 只有换了一个新的请求/新的回合才重新起表——不然每次 `refresh()`（每一步引擎
   * 事件之后都会调）都会把倒计时打回 100%。
   */
  function updateTimer(): void {
    const state = game.value?.state
    const slot = state ? currentWaitingSlot() : null
    if (!state || !slot) {
      timers.value = []
      clearHumanTimeoutTimer()
      waitingKey = ''
      return
    }
    const key = slot.request ? `req:${slot.request.id}` : `turn:${state.turnNumber}:${slot.playerId}`
    const now = Date.now()
    if (key !== waitingKey) {
      waitingKey = key
      waitingStartedAt = now
    }
    const isHuman = slot.playerId === HUMAN_ID
    const ai = !isHuman || trustee.value
    const deadlineAt = waitingStartedAt + nominalWindowMs(slot.request)
    const seatId = state.players.findIndex((candidate) => candidate.id === slot.playerId)
    timers.value = seatId < 0 ? [] : [{
      seatId, startedAt: waitingStartedAt, deadlineAt, kind: timerKindOf(state.status, slot.request), ai,
    }]

    clearHumanTimeoutTimer()
    // AI 的座位、或者真人已经托管：不需要强制超时，AI 自己按它自己的节奏会答，
    // 这条计时纯粹是给牌桌看的名义窗口。
    if (ai) return
    const capturedKey = key
    humanTimeoutTimer = window.setTimeout(() => { handleHumanTimeout(capturedKey) }, Math.max(0, deadlineAt - now))
  }

  /**
   * 真人这一步的操作时间到了。
   *
   * 口径和联机 `stepTimeout` 一致：默认是「放弃」，不是「AI 替他打」——
   * 超时的人没有授权任何人花他的牌。只有必须给出实质答案的请求（选将、
   * 强制弃牌之类没有「放弃」选项的）才临时借 AI 的决策替他答一次；
   * 连续超时达到阈值就自动转托管，交由 AI 按正常策略代打。
   */
  function handleHumanTimeout(key: string): void {
    if (key !== waitingKey || trustee.value) return
    const current = game.value
    if (!current) return
    const slot = currentWaitingSlot()
    if (!slot || slot.playerId !== HUMAN_ID) return
    const recomputedKey = slot.request ? `req:${slot.request.id}` : `turn:${current.state.turnNumber}:${slot.playerId}`
    if (recomputedKey !== key) return

    humanTimeoutStreak += 1
    const autoTrustee = humanTimeoutStreak >= AUTO_TRUSTEE_TIMEOUTS
    if (autoTrustee) humanTimeoutStreak = 0

    try {
      if (slot.request) {
        const passive = timeoutDefaultResponse(slot.request)
        current.respond(passive ?? aiModule!.decideResponse(contextFor(HUMAN_ID), slot.request))
      } else {
        current.advancePhase()
      }
      error.value = ''
      refresh()
      advanceUntilHuman(generation)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }

    if (autoTrustee) {
      pushLog('你连续多次未在时间内操作，已自动托管；任意操作即可收回。')
      setTrustee(true)
    }
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
      if (pending.playerId === HUMAN_ID && !trustee.value) { busy.value = false; refresh(); return }
      // 选将走短间隔：这一步没有任何动画，8 人局按正常节奏要等十几秒
      // 才开得了局，玩家只能盯着「其他角色选将中…」。
      step(revision, () => { current.respond(aiModule!.decideResponse(contextFor(pending.playerId), pending)) }, 'instant', pending.playerId)
      return
    }

    if (current.state.status !== 'playing') { refresh(); return }

    const request = current.state.pendingRequests[0]
    if (request) {
      if (request.playerId === HUMAN_ID && !trustee.value) { busy.value = false; refresh(); return }
      step(revision, () => { current.respond(aiModule!.decideResponse(contextFor(request.playerId), request)) }, aiModule!.isTrivialAIRequest(request) ? 'instant' : 'normal', request.playerId)
      return
    }

    const currentPlayer = current.state.players.find((player) => player.id === current.state.currentPlayerId)
    if (current.state.phase === 'play' && currentPlayer?.alive) {
      if (current.state.currentPlayerId === HUMAN_ID && !trustee.value) { busy.value = false; refresh(); return }
      const playerId = current.state.currentPlayerId
      const actions = current.legalActions(playerId)
      const onlyPass = actions.every((candidate) => candidate.kind === 'pass')
      step(revision, () => {
        const action = aiModule!.decidePlayAction(contextFor(playerId), actions)
        if (action) current.act(playerId, action.id)
        else {
          const pass = actions.find((candidate) => candidate.kind === 'pass')
          if (pass) current.act(playerId, pass.id)
        }
      }, onlyPass ? 'instant' : 'play', playerId)
      return
    }

    // 当前角色可能已经死了（苦肉、决斗、自己的闪电），回合要收束
    step(revision, () => { current.advancePhase() }, 'phase')
  }

  /** 执行一步，带视觉停顿；出错时把牌局停在原地并报出来，不静默吞掉。 */
  function step(revision: number, action: () => void, pace: 'normal' | 'play' | 'phase' | 'instant' = 'normal', owner: string | null = null): void {
    busy.value = true
    const run = () => {
      timer = null
      timerOwner = null
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
    else {
      timerOwner = owner
      timer = window.setTimeout(run, visualDelay)
    }
  }

  async function start(options: LocalMatchOptions): Promise<boolean> {
    generation += 1
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    timerOwner = null
    error.value = ''
    log.value = []
    presentationEvents.value = []
    trustee.value = false
    delayMs = options.aiDelayMs ?? AI_PACE_MS.normal
    currentDifficulty = options.difficulty
    turnSecondsValue = Math.max(1, Math.trunc(options.turnSeconds ?? DEFAULT_TURN_SECONDS))
    clearHumanTimeoutTimer()
    waitingKey = ''
    humanTimeoutStreak = 0
    timers.value = []
    busy.value = true
    try {
      await loadLocalAI()
    } catch (cause) {
      busy.value = false
      error.value = `本地 AI 加载失败：${cause instanceof Error ? cause.message : String(cause)}`
      return false
    }
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
    suspicion = beliefModule!.emptySuspicion(created.viewFor(HUMAN_ID))
    // 身份推断同样要接事件流，单机 AI 才会随着局势改变目标
    for (const name of ['Damaged', 'Recover'] as const) {
      created.events.on(name, (context) => { beliefModule!.observeEvent(suspicion, created.viewFor(HUMAN_ID), context.event) })
    }
    created.dealGenerals()
    applyDevLineup(created)
    refresh()
    pushLog(`牌局开始，${options.playerCount} 人身份局`)
    advanceUntilHuman(generation)
    return true
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
    humanTimeoutStreak = 0
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
    humanTimeoutStreak = 0
    try {
      current.act(HUMAN_ID, actionId)
      error.value = ''
      refresh()
      advanceUntilHuman(generation)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  /**
   * 单机托管默认由玩家手动开关；连续多次操作超时也会自动开启
   * （和联机口径一致），玩家自己动一下就会解除。
   * 取消时若“你”的下一步仍在视觉停顿中，立刻撤销该步并交还操作权。
   */
  function setTrustee(enabled: boolean): void {
    if (trustee.value === enabled || !game.value || finished.value) return
    trustee.value = enabled
    if (!enabled) humanTimeoutStreak = 0
    if (!enabled && timer !== null && timerOwner === HUMAN_ID) {
      window.clearTimeout(timer)
      timer = null
      timerOwner = null
      busy.value = false
      refresh()
      return
    }
    // 其他电脑已经在思考时沿用现有任务；重复调度会让同一步被执行两次。
    // 只有牌局正停在等待真人的节点（busy=false）才需要主动重新拉起驱动。
    if (enabled && !busy.value) advanceUntilHuman(generation)
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
    timer = null
    timerOwner = null
    clearHumanTimeoutTimer()
    waitingKey = ''
    humanTimeoutStreak = 0
    timers.value = []
    game.value = null
    view.value = null
    presentationEvents.value = []
    busy.value = false
    trustee.value = false
    error.value = ''
  }

  const legalActions = computed(() => (isMyTurn.value && !trustee.value ? view.value?.legalActions ?? [] : []))

  return { view, busy, error, log, presentationEvents, myRequest, isMyTurn, finished, legalActions, trustee, timers, setTrustee, start, respond, act, beginPlaying, abandon }
}
