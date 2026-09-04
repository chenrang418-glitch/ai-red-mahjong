import { createRulesetV1Deck } from '../data/ruleset-v1/deck'
import { enterDying, resolveDamage, resolveRescueResponse, resumeDamageChain, type DamageOptions } from './damage'
import { GameEventBus, type EventContext, type GameEvent, type GameEventName } from './events'
import { identitiesFor } from './modes/identity'
import { GameRng } from './rng'
import { startPlaying } from './turn'
import { advanceGamePhase, continuePhaseEntry, continueTurnTransition, recordDiscardPhaseMove, resolveDiscardPhaseResponse } from './phase'
import { beginVirtualSlash as startVirtualSlash, legalPlayActions, performPlayAction, resolveCardPickResponse, resolveCardResponse, resumeCardResolution, resumeCardTarget as continueCardTarget } from './cards/basic'
import { resolveBorrowedKnifeTarget } from './cards/tricks'
import { resolveJudgmentResponse, resolveRetrialResponse, resumeJudgment } from './judgment'
import { isGroupDecisionRequest, resolveGroupDecisionResponse } from './group-decision'
import { isPindianRequest, resolvePindianResponse } from './pindian'
import { GUHUO_RESPOND_ACTION, beginGuhuoRespond, continueGuhuoResponseAfterDying } from './guhuo-response'
import { RENNAI_ACTION, RENNAI_SKILL, armRennai } from './rennai'
import { markUsedThisTurn } from './turn-usage'
import { emptyEquipment, RULESET_VERSION, type GameSetup, type PlayerState, type SanguoshaState } from './types'
import type { GameRequest, GameResponse } from './requests'
import type { QueuedSkillPrompt } from './types'
import { validateResponse } from './requests'
import { allCharacterIds, entertainmentCharacterIds, getCharacter, isEntertainmentCharacter, skillIdsOf } from '../data/characters/standard'
import { getSkillRuntime, initializeGameSkills, registerSkillTriggers } from './skills/runtime'
import { buildPlayerView } from './view'
import { skillDisplayName } from './presentation'

export interface SanguoshaGameOptions {
  seed: string
  setup: GameSetup
}

function skillResponseWasInvoked(request: GameRequest, response: GameResponse): boolean {
  const payload = response.payload as Record<string, unknown>
  if ('actionId' in payload) return !String(payload.actionId).endsWith('-pass')
  if ('optionId' in payload) return !['no', 'pass', 'skip', 'cancel'].includes(String(payload.optionId))
  if (request.optional && 'cardIds' in payload) return Array.isArray(payload.cardIds) && payload.cardIds.length > 0
  if (request.optional && 'targetIds' in payload) return Array.isArray(payload.targetIds) && payload.targetIds.length > 0
  return true
}

export class SanguoshaGame {
  rng: GameRng
  readonly events = new GameEventBus()
  readonly state: SanguoshaState
  /**
   * 本次 act/respond 调用链里最近播过的技能横幅。
   *
   * 只在同一个调用链里有意义，所以不进 GameState；跨调用要保留的信息由
   * `skillResolution.announced` 负责（那个是序列化的）。
   */
  private recentAnnounce: { skillId: string; ownerId: string } | null = null

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
      characterPiles: {},
      grantedSkills: [],
      temporaryGrantedSkills: [],
      characterSkillsDisabled: false,
      awakenedSkills: [],
      zones: { hand: [], equipment: emptyEquipment(), judgingArea: [] },
      marks: {},
      usedLimitedSkills: [],
      turnUsedSkills: [],
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
      normalTurnPlayerId: lord.id,
      extraTurns: [],
      currentTurnKind: 'normal',
      targetStates: [],
      turnNumber: 0,
      phase: 'prepare',
      skippedPhases: [],
      phaseEntry: null,
      turnTransitionPending: false,
      turnUsage: { slashUses: 0, wineUses: 0, wineDamageBonus: 0 },
      pendingRequests: [],
      dying: null,
      damageChain: null,
      judgment: null,
      retrial: null,
      privateZones: [],
      groupDecision: null,
      pindian: null,
      pindianSettlement: null,
      discardPhaseLedger: null,
      huashen: null,
      guhuoResponse: null,
      mamaBonds: {},
      judgedDelayedCards: [],
      deathClaim: null,
      cardResolution: null,
      skillResolution: null,
      skillQueue: [],
      rngState: 0,
      cardAliases: {},
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
    if (name === 'SkillActivated') {
      // 记下刚报过谁的什么技能，紧接着的 askSkill 靠它判断「这次发动已经报过了」。
      // 只在同一次 act/respond 的调用链里有效，入口处会清掉。
      this.recentAnnounce = {
        skillId: String(payload.skillId ?? ''),
        ownerId: String(metadata.sourceId ?? payload.playerId ?? ''),
      }
    }
    const seq = ++this.state.seq
    if (name === 'CardMove') recordDiscardPhaseMove(this.state, payload, seq)
    const event: GameEvent = { id: `event-${seq}`, seq, name, payload, ...metadata }
    return this.events.emit(event)
  }

  damage(options: DamageOptions): void {
    resolveDamage(this, options)
  }

  /**
   * 技能发问。写下可序列化的等待状态，把 Request 挂进 pendingRequests。
   *
   * 挂着 Request 时 `advancePhase` 会拒绝推进，所以牌局自然停在这里等回应，
   * 不需要任何形式的 `await`。
   */
  askSkill(options: {
    skillId: string
    ownerId: string
    step: string
    data?: Record<string, unknown>
    build(requestId: string): GameRequest
  }): void {
    if (this.state.skillResolution) throw new Error('已有技能正在等待回应')
    const requestId = `request-skill-${++this.state.seq}`
    const request = options.build(requestId)
    if (request.id !== requestId) throw new Error('技能 Request id 必须使用引擎分配的值')
    this.state.skillResolution = {
      kind: 'skill',
      skillId: options.skillId,
      ownerId: options.ownerId,
      step: options.step,
      requestId,
      data: structuredClone(options.data ?? {}),
      // 刚刚为这个技能报过横幅（引擎兜底的那条，或者武将自己发的那条）就记下来，
      // 后面的步骤不再重复播
      announced: this.recentAnnounce?.skillId === options.skillId
        && this.recentAnnounce.ownerId === options.ownerId,
    }
    this.state.pendingRequests.push(request)
  }

  enterDying(playerId: string): void {
    enterDying(this, playerId)
  }

  resumeAfterDying(): void {
    if (this.state.dying) return
    if (continueGuhuoResponseAfterDying(this)) return
    resumeDamageChain(this)
    if (!this.state.dying && !this.state.damageChain) {
      resumeJudgment(this)
      if (!this.state.judgment) resumeCardResolution(this)
    }
  }

  beginVirtualSlash(options: { sourceId: string; targetId: string; sourceSkillId: string; nature?: 'normal' | 'fire' | 'thunder'; cardId?: string }): void {
    startVirtualSlash(this, options)
  }

  resumeCardTarget(): void {
    continueCardTarget(this)
  }

  resumePhaseEntry(): void {
    continuePhaseEntry(this)
  }

  queueSkill(prompt: QueuedSkillPrompt): void {
    this.state.skillQueue.push(structuredClone(prompt))
  }

  /**
   * 牌局回到干净状态时，把排队的技能发问放出去。
   *
   * 「干净」= 没有待处理 Request、没有濒死、没有属性传导、没有牌在结算中。
   * 这时候发问才不会和别的结算抢同一个玩家的注意力。
   */
  private drainSkillQueue(): void {
    while (
      this.state.skillQueue.length > 0
      && this.state.status === 'playing'
      && !this.state.skillResolution
      && this.state.pendingRequests.length === 0
      && !this.state.dying
      && !this.state.damageChain
      && !this.state.cardResolution
      && !this.state.judgment
    ) {
      const prompt = this.state.skillQueue.shift()!
      const runtime = getSkillRuntime(prompt.skillId)
      const owner = this.state.players.find((candidate) => candidate.id === prompt.ownerId)
      // 触发之后武将可能已经死了或者被换掉，前提不成立就安静地丢弃
      if (!runtime?.startQueued || !owner?.alive) continue
      runtime.startQueued(this, prompt.ownerId, prompt)
    }
  }

  /** 牌局往前走一步之后统一收尾：把排队的技能发问放出去。 */
  private settle(): void {
    this.drainSkillQueue()
    if (
      this.state.turnTransitionPending
      && this.state.skillQueue.length === 0
      && !this.state.skillResolution
      && this.state.pendingRequests.length === 0
      && !this.state.dying
      && !this.state.damageChain
      && !this.state.cardResolution
      && !this.state.judgment
    ) {
      continueTurnTransition(this)
      this.drainSkillQueue()
    }
  }

  respond(response: GameResponse): void {
    this.recentAnnounce = null
    this.respondInner(response)
    this.settle()
  }

  private respondInner(response: GameResponse): void {
    const request = this.state.pendingRequests.find((candidate) => candidate.id === response.requestId)
    if (!request) throw new Error('Request 不存在或已经处理')

    /*
     * 无亮【忍耐】：**改写成一次普通的「放弃响应」**，然后记一笔账。
     *
     * 放在这里而不是各条求牌路径里，是因为它对结算的影响只有「这次不响应」，
     * 后面该怎么走还怎么走。翻译成 respond-pass 之后原来那套校验、记录、
     * 推进全部照旧，不需要在求闪 / 锦囊效果 / 无懈三处各写一遍恢复逻辑。
     */
    if ((response.payload as { actionId?: string })?.actionId === RENNAI_ACTION) {
      if (!('actionIds' in request) || !request.actionIds.includes(RENNAI_ACTION)) {
        throw new Error('当前请求不能发动忍耐')
      }
      markUsedThisTurn(this.state, response.playerId, RENNAI_SKILL)
      armRennai(this.state, response.playerId)
      this.dispatch('SkillActivated', {
        skillId: RENNAI_SKILL, skillName: '忍耐', playerId: response.playerId, result: 'endure',
        logText: `${this.state.players.find((candidate) => candidate.id === response.playerId)?.nickname ?? ''}发动【忍耐】，放弃这次响应`,
      }, { sourceId: response.playerId })
      this.respondInner({ ...response, payload: { actionId: 'respond-pass' } })
      return
    }

    /*
     * 于吉【蛊惑】的「打出」模式只有这一个入口。
     *
     * 所有求牌请求都是「给一串 actionId、挑一个」，所以在请求里多加一条
     * `guhuo-respond`、再在这里集中认领，就不用在求闪 / 求桃 / 无懈 /
     * 锦囊效果这五条路径里各写一遍挂起和恢复。
     */
    if ((response.payload as { actionId?: string })?.actionId === GUHUO_RESPOND_ACTION) {
      if (!('actionIds' in request) || !request.actionIds.includes(GUHUO_RESPOND_ACTION)) {
        throw new Error('当前请求不能用蛊惑打出')
      }
      beginGuhuoRespond(this, request as unknown as GameRequest)
      return
    }

    // 拼点选牌：两边各有一个请求，都交完才揭示
    if (isPindianRequest(this.state, request.id)) {
      const validationError = validateResponse(request, response)
      if (validationError) throw new Error(validationError)
      resolvePindianResponse(this, request.id, response)
      return
    }

    // 多人同时决定的一环：每个人各有一个请求，收齐之后统一处理
    if (isGroupDecisionRequest(this.state, request.id)) {
      resolveGroupDecisionResponse(this, request.id, response)
      return
    }

    // 技能自己发起的 Request 优先认领：requestId 唯一，不会和牌的结算混淆
    const skillResolution = this.state.skillResolution
    if (skillResolution && skillResolution.requestId === request.id) {
      const validationError = validateResponse(request, response)
      if (validationError) throw new Error(validationError)
      const runtime = getSkillRuntime(skillResolution.skillId)
      if (!runtime?.resume) throw new Error(`技能缺少续接实现：${skillResolution.skillId}`)
      // 这次发动已经报过横幅就不再补：多步技能否则会连播好几遍同一个技能名。
      // 技能自己会报的（announcesSelf）也不补，那两条会挨在一起变成重复播放。
      if (!skillResolution.announced && !runtime.announcesSelf && skillResponseWasInvoked(request, response)) {
        this.dispatch('SkillActivated', { skillId: skillResolution.skillId, skillName: skillDisplayName(skillResolution.skillId) }, { sourceId: skillResolution.ownerId })
      } else if (skillResolution.announced) {
        // 续接下一步时 askSkill 要能继续认出「已经报过」
        this.recentAnnounce = { skillId: skillResolution.skillId, ownerId: skillResolution.ownerId }
      }
      this.state.pendingRequests = this.state.pendingRequests.filter((candidate) => candidate.id !== request.id)
      // 先清空再回调，技能才能在 resume 里接着问下一步
      this.state.skillResolution = null
      this.state.decisions.push({
        index: this.state.decisions.length,
        requestId: request.id,
        playerId: response.playerId,
        kind: request.kind,
        payload: structuredClone(response.payload),
      })
      runtime.resume(this, skillResolution.ownerId, skillResolution, response)
      return
    }
    if (request.kind === 'rescue') {
      resolveRescueResponse(this, request, response)
      this.resumeAfterDying()
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
      // 单机自选可能挑中原本分给 AI 的普通武将。普通武将保持唯一；
      // 娱乐包是固定公共候选，明确允许一桌多人选择同一个。
      if (!isEntertainmentCharacter(characterId)) {
        for (const pending of this.state.pendingRequests) {
          if (pending.kind !== 'choose-general') continue
          pending.candidates = pending.candidates.filter((candidate) => candidate !== characterId)
        }
      }
      this.state.decisions.push({
        index: this.state.decisions.length,
        requestId: request.id,
        playerId: response.playerId,
        kind: request.kind,
        payload: structuredClone(response.payload),
      })
      return
    }
    // 改判（鬼才）：判定牌翻开之后、生效之前的插入点
    if (request.kind === 'choose-cards' && request.purpose === 'retrial') {
      resolveRetrialResponse(this, request, response)
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
    this.recentAnnounce = null
    advanceGamePhase(this)
    this.settle()
  }

  legalActions(playerId: string) {
    return legalPlayActions(this.state, playerId)
  }

  act(playerId: string, actionId: string): void {
    this.recentAnnounce = null
    performPlayAction(this, playerId, actionId)
    this.settle()
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
    const allIds = allCharacterIds()
    const fixedCandidates = entertainmentCharacterIds()
    const fixedSet = new Set(fixedCandidates)
    const pool = this.rng.shuffle(allIds)
    // 每个人的候选互不重叠，所以武将总数必须够分。不够就直接报错，
    // 不能静默给最后一个人发一份空候选——那会变成他永远选不了将。
    if (pool.length < this.state.players.length) {
      throw new Error(`已实现的武将只有 ${pool.length} 个，不足 ${this.state.players.length} 人局分配`)
    }
    const perPlayer = Math.max(1, Math.min(this.state.setup.generalChoices, Math.floor(pool.length / this.state.players.length)))
    this.state.players.forEach((player, index) => {
      const randomCandidates = pool.slice(index * perPlayer, (index + 1) * perPlayer)
      /*
       * 固定的「自定义武将」池**只发给真人**。
       *
       * 娱乐武将是给朋友之间图个乐子的，AI 每局都能拿到会让它们频繁出现，
       * 冲淡正常牌局。AI 仍然可能选到娱乐武将——那是随机池里恰好分到的，
       * 和这个固定池是两回事。
       */
      const showsFixedPool = player.isHuman
      const candidates = showsFixedPool
        ? [...randomCandidates, ...fixedCandidates.filter((id) => !randomCandidates.includes(id))]
        : randomCandidates
      this.state.pendingRequests.push({
        id: `request-general-${player.id}`,
        kind: 'choose-general',
        playerId: player.id,
        prompt: '选择你的武将',
        timeoutMs: 60_000,
        optional: false,
        candidates,
        allCandidates: player.isHuman && this.state.setup.allowHumanGeneralSelection ? [...allIds] : undefined,
        fixedCandidates: showsFixedPool ? [...fixedSet] : [],
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
    initializeGameSkills(this)
    // 开局排队的发问（牛来认麻麻）在这里就放出去，
    // 否则要等到第一次 act/advancePhase 才轮到，第一个准备阶段已经过去了
    this.settle()
  }

  viewFor(playerId: string) {
    return buildPlayerView(this.state, playerId)
  }

  /**
   * 可持久化的完整状态。
   *
   * 必须带上随机源快照——只存 seed 的话，Durable Object 醒来后会从头推导随机序列，
   * 和休眠前发散。
   */
  serialize(): SanguoshaState {
    return structuredClone({ ...this.state, rngState: this.rng.snapshot() })
  }

  /**
   * 从持久化状态恢复。
   *
   * 技能触发器是运行时代码，序列化不了，所以这里必须重新注册一遍——
   * 这正是 `registerSkillTriggers` 文档里点名的那件事。
   */
  static restore(stored: SanguoshaState): SanguoshaGame {
    const game = Object.create(SanguoshaGame.prototype) as SanguoshaGame
    const mutable = game as { state: SanguoshaState; rng: GameRng; events: GameEventBus }
    mutable.state = structuredClone(stored)
    // 旧存档里没有这张表，补一个空的，免得后续读写炸掉
    mutable.state.cardAliases ??= {}
    // 专属牌堆是后加的字段，进行中的旧房间里没有
    for (const player of mutable.state.players) player.characterPiles ??= {}
    // 动态授技与觉醒记账是后加的字段，进行中的旧房间里没有
    for (const player of mutable.state.players) {
      player.grantedSkills ??= []
      player.temporaryGrantedSkills ??= []
      player.awakenedSkills ??= []
      player.characterSkillsDisabled ??= false
    }
    mutable.state.judgedDelayedCards ??= []
    mutable.state.privateZones ??= []
    mutable.state.groupDecision ??= null
    mutable.state.pindian ??= null
    mutable.state.pindianSettlement ??= null
    mutable.state.discardPhaseLedger ??= null
    mutable.state.huashen ??= null
    mutable.state.guhuoResponse ??= null
    // 阶段进入窗口是后加的字段，进行中的旧房间里没有
    mutable.state.phaseEntry ??= null
    mutable.state.turnTransitionPending ??= false
    // 额外回合调度是后加的字段，进行中的旧房间里没有：
    // 座次游标兜底成当前回合角色，队列兜底成空
    mutable.state.extraTurns ??= []
    mutable.state.normalTurnPlayerId ??= mutable.state.currentPlayerId
    mutable.state.currentTurnKind ??= 'normal'
    // 临时角色状态是后加的字段，进行中的旧房间里没有
    mutable.state.targetStates ??= []
    mutable.state.mamaBonds ??= {}
    if (mutable.state.damageChain) {
      mutable.state.damageChain.cardId ??= null
      mutable.state.damageChain.cardName ??= null
      mutable.state.damageChain.redirectedBy ??= null
    }
    // 部署前已经持久化的进行中牌局没有多响应计数；按旧规则的一张响应恢复，不能让升级把房间卡成 NaN。
    const resolution = mutable.state.cardResolution
    if (resolution?.kind === 'slash' && !Number.isInteger(resolution.dodgeRemaining)) resolution.dodgeRemaining = 1
    if (resolution?.kind === 'trick' && resolution.effect?.kind === 'duel' && !Number.isInteger(resolution.effect.slashRemaining)) {
      resolution.effect.slashRemaining = 1
    }
    if (resolution?.kind === 'trick') {
      resolution.interceptsDone ??= []
      resolution.cancelledTargetIds ??= []
      resolution.unresponsiveTargetIds ??= []
    }
    mutable.rng = new GameRng(`${stored.rulesetVersion}:${stored.seed}`, stored.rngState || undefined)
    mutable.events = new GameEventBus()
    registerSkillTriggers(game, (event, handler, priority) => { game.events.on(event, handler, priority) }, skillIdsOf)
    return game
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
