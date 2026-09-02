import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest, GameResponse } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { CardId, PhysicalCard, PlayerId, SanguoshaState } from '../../engine/types'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 好友娱乐包·牛来。
 *
 * 【牛来】是赌博式的追涨：翻牌、拿牌、决定继续还是收手，一旦翻出更小的点数，
 * 本次拿到的全部吐回去。【妈妈】是伤害转移：打不过就把这一下甩给别人。
 *
 * 两条实现上的硬约束：
 *
 * 1. **失败清仓按 cardId 追踪**，不是「弃最后 N 张手牌」。技能过程中拿到的牌
 *    可能被别的效果拿走（顺手牵羊、过河拆桥），清仓时只处理**仍然属于牛来**
 *    的那几张，不去别人区域里抢。
 * 2. **【妈妈】转移的是原伤害本身**，不是牛来重新造一份新伤害：来源、点数、
 *    属性、牌全部原样带过去。复用小乔【天香】走通的那条路
 *    （DamageInflicted 里取消 + 排队 + 用同一份 facts 重新 resolveDamage）。
 */

export const NIULAI = 'niulai'
export const MAMA = 'mama'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/**
 * 【牛来】用的点数大小。
 *
 * **A 是最大的（14），不是 1。** 牌库里 A 的 rank 就是 1，
 * 直接拿 `card.rank` 比会让 A 变成最小，追涨的手感整个反过来。
 */
export function niulaiRank(card: Pick<PhysicalCard, 'rank'>): number {
  return card.rank === 1 ? 14 : card.rank
}

/** 连续成功几次时说什么。纯表现，不影响任何数值。 */
function streakText(streak: number): string {
  if (streak >= 4) return '牛来！！！'
  if (streak === 3) return '牛真来了！'
  if (streak === 2) return '好像真来了'
  return '牛来了！'
}

/**
 * 翻开牌堆顶一张牌，放进处理区并公开。
 *
 * 牌堆空了就用现有的「弃牌堆洗回牌堆」——不另写一套洗牌。
 * 一张牌都没有时返回 null，调用方安全收尾。
 */
function revealTop(host: SkillHost, playerId: PlayerId, reason: string): CardId | null {
  if (host.state.zones.drawPile.length === 0) {
    if (host.state.zones.discardPile.length === 0) return null
    host.state.zones.drawPile.push(...host.rng.shuffle(host.state.zones.discardPile))
    host.state.zones.discardPile.length = 0
  }
  const cardId = host.state.zones.drawPile[0]
  if (!cardId) return null
  moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
  host.dispatch('CardMove', {
    playerId, cardIds: [cardId], reason, revealed: true,
  }, { targetId: playerId, cardIds: [cardId] })
  return cardId
}

// ─────────────────────────────── 牛来 ───────────────────────────────

const CONTINUE = 'niulai-continue'
const STOP = 'niulai-stop'

registerSkillRuntime({
  id: NIULAI,

  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, NIULAI)) return []
    return [{ id: `skill:${NIULAI}`, label: '发动【牛来】：展示牌堆顶一张牌并获得，然后决定继续还是收手' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${NIULAI}`) throw new Error('牛来动作不匹配')
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    // 先记账：中途取消不能刷次数
    markUsedThisTurn(host.state, ownerId, NIULAI)
    // 第一张不存在失败可能，直接翻开就拿
    const cardId = revealTop(host, ownerId, NIULAI)
    if (!cardId) return
    gainRevealed(host, ownerId, cardId)
    askContinue(host, ownerId, {
      lastRank: niulaiRank(host.state.cards[cardId]),
      gained: [cardId],
      streak: 1,
    })
  },

  resume(host, ownerId, resolution, response: GameResponse) {
    if (resolution.step !== 'ask') return
    const progress = progressOf(resolution.data)
    const owner = playerOf(host.state, ownerId)
    // 中途死了就当收手：已经拿到的牌照常留着
    if (!owner?.alive) return
    if ((response.payload as { optionId?: string }).optionId !== CONTINUE) {
      host.dispatch('SkillActivated', {
        skillId: NIULAI, skillName: '牛来', playerId: ownerId, result: 'stop', gained: progress.gained.length,
      }, { sourceId: ownerId })
      return
    }

    const cardId = revealTop(host, ownerId, NIULAI)
    // 牌堆和弃牌堆都空了：安全结束，之前拿到的牌保留
    if (!cardId) return
    const revealed = host.state.cards[cardId]
    const rank = niulaiRank(revealed)

    // **相等算成功**，只有严格变小才算失败
    if (rank >= progress.lastRank) {
      gainRevealed(host, ownerId, cardId)
      askContinue(host, ownerId, {
        lastRank: rank,
        gained: [...progress.gained, cardId],
        streak: progress.streak + 1,
      })
      return
    }

    // 牛走了：翻出来的这张进弃牌堆，本次拿到的全部吐回去
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    discardGained(host, ownerId, progress.gained)
    host.dispatch('SkillActivated', {
      skillId: NIULAI, skillName: '牛来', playerId: ownerId, result: 'bust', lost: progress.gained.length,
    }, { sourceId: ownerId })
  },
})

interface NiulaiProgress {
  lastRank: number
  gained: CardId[]
  streak: number
}

function progressOf(data: Record<string, unknown>): NiulaiProgress {
  return {
    lastRank: Number(data.lastRank ?? 0),
    gained: (data.gained as CardId[] | undefined) ?? [],
    streak: Number(data.streak ?? 0),
  }
}

/** 把刚翻开的牌收进手里。牌是公开翻出来的，所以 GainCard 带 revealed。 */
function gainRevealed(host: SkillHost, ownerId: PlayerId, cardId: CardId): void {
  moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
  host.dispatch('GainCard', {
    playerId: ownerId, cardIds: [cardId], reason: NIULAI, revealed: true,
  }, { targetId: ownerId, cardIds: [cardId] })
}

/**
 * 清仓：把本次【牛来】拿到的牌弃掉。
 *
 * **逐张按 cardId 检查当前位置**——过程中某张牌可能已经被顺手牵羊拿走了，
 * 那就不管它，不去别人区域里抢回来。
 */
function discardGained(host: SkillHost, ownerId: PlayerId, gained: readonly CardId[]): void {
  const discarded: CardId[] = []
  for (const cardId of gained) {
    const zone = locateOwnedCard(host.state, ownerId, cardId)
    if (!zone) continue
    moveCard(host.state, cardId, zone, { kind: 'discardPile' })
    discarded.push(cardId)
  }
  if (discarded.length === 0) return
  host.dispatch('LoseCard', {
    playerId: ownerId, cardIds: discarded, reason: NIULAI,
  }, { targetId: ownerId, cardIds: discarded })
}

function askContinue(host: SkillHost, ownerId: PlayerId, progress: NiulaiProgress): void {
  host.askSkill({
    skillId: NIULAI,
    ownerId,
    step: 'ask',
    data: { ...progress },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId,
      kind: 'choose-option',
      playerId: ownerId,
      prompt: `${streakText(progress.streak)}当前点数 ${progress.lastRank}，已拿 ${progress.gained.length} 张。继续还是收手？`,
      timeoutMs: 20_000,
      optional: false,
      options: [
        { id: CONTINUE, label: '继续：再翻一张，点数不下降就拿走，否则本次全部弃置' },
        { id: STOP, label: '收手：结束技能，保留已经拿到的牌' },
      ],
    }),
  })
}

// ─────────────────────────────── 麻麻 ───────────────────────────────
//
// 认妈 → 跟妈打人 → 继承遗产 → 重新认妈。
//
// 三个实现要点：
//
// 1. **认亲关系放在 `state.mamaBonds`**（牛来 id → 麻麻 id）。`player.marks`
//    只存数字，存不下 playerId；而这是公开信息、服务端权威，断线重连和多客户端
//    都要看到同一份，所以必须进牌局状态而不是留在某一侧的内存里。
// 2. **跟杀走 queueSkill**。麻麻的【杀】还在结算时 `state.cardResolution` 被占着，
//    当场再起一张【杀】会直接抛「已有卡牌正在结算」。排队等这张杀走完再问，
//    正好也是规则想要的时序。
// 3. **遗产由第一个跑到的 BeforeDeath 处理器一次性分完**，并顺手清掉所有指向
//    死者的认亲关系。若各删各的，后跑的牛来会因为前面那条已经不在了而重新
//    算出自己是继承人，同一套实体牌被分两次。

/** 战报里这个技能的名字。 */
const MAMA_NAME = '麻麻'

const FOLLOW = 'mama-follow'
const HELP = 'mama-help'

/** 牛来当前的麻麻；没认过或者已经阵亡都算没有。 */
export function mamaOf(state: SanguoshaState, ownerId: PlayerId): PlayerId | null {
  const mamaId = state.mamaBonds?.[ownerId]
  if (!mamaId) return null
  const mama = playerOf(state, mamaId)
  return mama?.alive ? mamaId : null
}

/** 这个人是不是某个牛来的「麻麻」——座位卡上的公开标记要用。 */
export function isMamaOfAnyone(state: SanguoshaState, playerId: PlayerId): boolean {
  return Object.values(state.mamaBonds ?? {}).includes(playerId)
}

function otherAliveIds(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
}

/** 手上真正的【杀】。转化技（武圣这类）不算，规则要求的是实体【杀】。 */
function realSlashIds(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const owner = playerOf(state, playerId)
  if (!owner) return []
  return owner.zones.hand.filter((cardId) => state.cards[cardId]?.name === '杀')
}

/** 牛来现在能弃的牌：手牌加装备区。 */
function discardableCardIds(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const owner = playerOf(state, playerId)
  if (!owner?.alive) return []
  const equipment = Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))
  return [...owner.zones.hand, ...equipment]
}

/** 队列里已经排了同一件事就不要再排一次（同一回合多次触发、事件重入）。 */
function alreadyQueued(host: SkillHost, ownerId: PlayerId, step: string): boolean {
  if (host.state.skillQueue.some((prompt) => prompt.skillId === MAMA && prompt.ownerId === ownerId && prompt.step === step)) return true
  const resolution = host.state.skillResolution
  return Boolean(resolution && resolution.skillId === MAMA && resolution.ownerId === ownerId)
}

function queueMama(host: SkillHost, ownerId: PlayerId, step: string, data: Record<string, unknown> = {}): void {
  if (alreadyQueued(host, ownerId, step)) return
  host.queueSkill({ skillId: MAMA, ownerId, step, data })
}

// ── 认麻麻 ──

function askPickMama(host: SkillHost, ownerId: PlayerId): void {
  const candidateIds = otherAliveIds(host.state, ownerId)
  // 场上只剩自己：没得认，也不用弹窗
  if (candidateIds.length === 0) return
  host.askSkill({
    skillId: MAMA,
    ownerId,
    step: 'pick',
    build: (requestId): ChooseTargetsRequest => ({
      id: requestId,
      kind: 'choose-targets',
      playerId: ownerId,
      prompt: '【麻麻】：选择一名其他角色成为你的「麻麻」',
      timeoutMs: 20_000,
      // 规则是必须认，不是可选
      optional: false,
      candidateIds,
      min: 1,
      max: 1,
    }),
  })
}

function setMama(host: SkillHost, ownerId: PlayerId, mamaId: PlayerId): void {
  host.state.mamaBonds[ownerId] = mamaId
  const owner = playerOf(host.state, ownerId)
  const mama = playerOf(host.state, mamaId)
  host.dispatch('SkillActivated', {
    skillId: MAMA, skillName: MAMA_NAME, playerId: ownerId, targetIds: [mamaId], result: 'pick',
    logText: `${owner?.nickname ?? ''}认${mama?.nickname ?? ''}为【麻麻】`,
  }, { sourceId: ownerId, targetId: mamaId })
}

// ── 跟杀 ──

interface FollowData {
  targetIds: PlayerId[]
  mode: 'follow' | 'help' | null
  targetId: PlayerId | null
}

function followDataOf(data: Record<string, unknown>): FollowData {
  return {
    targetIds: (data.targetIds as PlayerId[] | undefined) ?? [],
    mode: (data.mode as FollowData['mode']) ?? null,
    targetId: (data.targetId as PlayerId | null) ?? null,
  }
}

/** 跟杀还剩哪些合法目标：必须仍然存活，且不是牛来自己。 */
function followCandidates(state: SanguoshaState, ownerId: PlayerId, targetIds: readonly PlayerId[]): PlayerId[] {
  return targetIds.filter((targetId) => targetId !== ownerId && Boolean(playerOf(state, targetId)?.alive))
}

function startFollow(host: SkillHost, ownerId: PlayerId, data: Record<string, unknown>): void {
  const facts = followDataOf(data)
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || usedThisTurn(host.state, ownerId, MAMA)) return
  const candidateIds = followCandidates(host.state, ownerId, facts.targetIds)
  if (candidateIds.length === 0) return

  const canFollow = realSlashIds(host.state, ownerId).length > 0
  const canHelp = discardableCardIds(host.state, ownerId).length >= 2
  // 两种都做不到就**根本不发问**，别弹一个只能点取消的窗口
  if (!canFollow && !canHelp) return

  const options: Array<{ id: string; label: string }> = []
  if (canFollow) options.push({ id: FOLLOW, label: '跟上：使用一张【杀】，无距离限制且不计次数' })
  if (canHelp) options.push({ id: HELP, label: '帮忙：弃置两张牌，视为使用一张【杀】' })
  options.push({ id: 'cancel', label: '算了：不跟' })

  host.askSkill({
    skillId: MAMA,
    ownerId,
    step: 'ask',
    data: { ...data, targetIds: candidateIds },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId,
      kind: 'choose-option',
      playerId: ownerId,
      prompt: '麻麻我来了！是否发动【麻麻】跟一刀？',
      timeoutMs: 20_000,
      optional: true,
      options,
    }),
  })
}

function askFollowTarget(host: SkillHost, ownerId: PlayerId, data: Record<string, unknown>, candidateIds: PlayerId[]): void {
  host.askSkill({
    skillId: MAMA,
    ownerId,
    step: 'target',
    data,
    build: (requestId): ChooseTargetsRequest => ({
      id: requestId,
      kind: 'choose-targets',
      playerId: ownerId,
      prompt: '【麻麻】：选择一名麻麻的目标跟杀',
      timeoutMs: 20_000,
      optional: false,
      candidateIds,
      min: 1,
      max: 1,
    }),
  })
}

function askFollowCards(host: SkillHost, ownerId: PlayerId, data: Record<string, unknown>, mode: FollowData['mode']): void {
  const isFollow = mode === 'follow'
  const cardIds = isFollow ? realSlashIds(host.state, ownerId) : discardableCardIds(host.state, ownerId)
  host.askSkill({
    skillId: MAMA,
    ownerId,
    step: isFollow ? 'card' : 'discard',
    data,
    build: (requestId): ChooseCardsRequest => ({
      id: requestId,
      kind: 'choose-cards',
      playerId: ownerId,
      prompt: isFollow ? '【麻麻】：选择要使用的【杀】' : '【麻麻】：弃置两张牌',
      timeoutMs: 20_000,
      optional: false,
      purpose: 'skill',
      cardIds,
      hiddenCardSlots: [],
      min: isFollow ? 1 : 2,
      max: isFollow ? 1 : 2,
    }),
  })
}

/**
 * 真正打出这一刀。`cardId` 为空就是「帮忙」生成的虚拟【杀】。
 *
 * 走的是引擎统一的 `beginVirtualSlash`：完整的【杀】使用事件，
 * 目标能正常出【闪】，杀相关技能照常触发，**不是直接造成 1 点伤害**。
 */
function fireFollowSlash(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, cardId: CardId | null): void {
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  // 排队期间目标可能已经死了，那就到此为止（次数已经记过，不退）
  if (!owner?.alive || !target?.alive) return
  host.dispatch('SkillActivated', {
    skillId: MAMA, skillName: MAMA_NAME, playerId: ownerId, targetIds: [targetId],
    result: cardId ? 'follow' : 'help',
    logText: cardId
      ? `${owner.nickname}发动【麻麻】跟上，对${target.nickname}使用【杀】`
      : `${owner.nickname}发动【麻麻】，弃置两张牌视为对${target.nickname}使用【杀】`,
  }, { sourceId: ownerId, targetId })
  host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: MAMA, cardId: cardId ?? undefined })
}

// ── 遗产 ──

/**
 * 谁来继承这份遗产。
 *
 * 从死者的下家起顺时针找第一名「认死者为麻麻」且仍然活着的牛来。
 * 用座次而不是别的顺序是为了**确定性**：联机两端、重连前后必须算出同一个人。
 * 一起判 `hp > 0`，避免同一轮里正在濒死的牛来把牌拿走。
 */
function heirFor(state: SanguoshaState, deadId: PlayerId): PlayerId | null {
  const dead = playerOf(state, deadId)
  if (!dead) return null
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const candidate = state.players[(dead.seat + offset) % state.players.length]
    if (!candidate.alive || candidate.hp <= 0) continue
    if (state.mamaBonds?.[candidate.id] === deadId) return candidate.id
  }
  return null
}

/**
 * 把麻麻的手牌和装备牌转给继承人。
 *
 * **必须在 BeforeDeath 里做**：死亡流程随后会把这些牌弃进弃牌堆，
 * 那时候再拿就是从弃牌堆里捞，容易写成复制。判定区的牌不在遗产里，
 * 按原死亡流程处理。装备牌进的是**手牌**，不自动穿上。
 */
function inheritEstate(host: SkillHost, heirId: PlayerId, deadId: PlayerId): void {
  const dead = playerOf(host.state, deadId)
  const heir = playerOf(host.state, heirId)
  if (!dead || !heir) return
  const moved: CardId[] = []
  for (const cardId of [...dead.zones.hand]) {
    moveCard(host.state, cardId, { kind: 'hand', playerId: deadId }, { kind: 'hand', playerId: heirId })
    moved.push(cardId)
  }
  for (const slot of Object.keys(dead.zones.equipment) as Array<keyof typeof dead.zones.equipment>) {
    const cardId = dead.zones.equipment[slot]
    if (!cardId) continue
    moveCard(host.state, cardId, { kind: 'equipment', playerId: deadId, slot }, { kind: 'hand', playerId: heirId })
    // 白银狮子这类「失去装备」的效果照常触发，和被拆掉一个待遇
    host.dispatch('LoseEquipment', { playerId: deadId, cardId, slot }, { targetId: deadId, cardIds: [cardId] })
    moved.push(cardId)
  }
  if (moved.length === 0) return
  host.dispatch('GainCard', { playerId: heirId, cardIds: moved, reason: MAMA }, { targetId: heirId, cardIds: moved })
  host.dispatch('SkillActivated', {
    skillId: MAMA, skillName: MAMA_NAME, playerId: heirId, targetIds: [deadId], result: 'inherit',
    logText: `${heir.nickname}获得${dead.nickname}的手牌和装备牌（共${moved.length}张）`,
  }, { sourceId: heirId, targetId: deadId })
}

registerSkillRuntime({
  id: MAMA,
  // 认亲、跟杀、被打懵、继承遗产各有自己的横幅文案，引擎那条会和它撞在一起
  announcesSelf: true,
  triggers: [
    {
      /*
       * 开局认麻麻。
       *
       * 挂在第一个回合开始而不是 GameStart：GameStart 在 SanguoshaGame 的
       * 构造函数里就发了，那时候武将还没分配，技能根本不会被调到。
       */
      event: 'TurnStart',
      handle(host, ownerId, context) {
        if (Number(context.event.payload.turnNumber) !== 1) return
        if (mamaOf(host.state, ownerId)) return
        queueMama(host, ownerId, 'pick')
      },
    },
    {
      // 麻麻没了：自己的准备阶段必须重新认一个
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        if (context.event.payload.phase !== 'prepare') return
        if (context.event.payload.playerId !== ownerId) return
        if (mamaOf(host.state, ownerId)) return
        queueMama(host, ownerId, 'pick')
      },
    },
    {
      // 麻麻使用【杀】：跟一刀
      event: 'CardUsed',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardName?: string; targetIds?: PlayerId[] }
        if (payload.cardName !== '杀') return
        const mamaId = mamaOf(host.state, ownerId)
        if (!mamaId || context.event.sourceId !== mamaId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const targetIds = Array.isArray(payload.targetIds) ? payload.targetIds : []
        if (targetIds.length === 0) return
        if (targetIds.includes(ownerId)) {
          // 只要牛来是这张【杀】的目标之一就完全不能跟，多目标也一样
          host.dispatch('SkillActivated', {
            skillId: MAMA, skillName: MAMA_NAME, playerId: ownerId, result: 'stunned',
            logText: `${owner.nickname}陷入沉思：麻麻你怎么打我？`,
          }, { sourceId: ownerId })
          return
        }
        if (usedThisTurn(host.state, ownerId, MAMA)) return
        queueMama(host, ownerId, 'follow', { targetIds: [...targetIds] })
      },
    },
    {
      /*
       * 遗产。挂在 BeforeDeath 上、优先级压到最低：救人的技能先跑完，
       * 确实没救回来（hp 仍然不大于 0）才轮到分牌。
       *
       * **第一个跑到的处理器把事情一次做完**：算继承人、清掉所有指向死者的
       * 认亲关系、转牌。若各删各的，后跑的牛来会因为前面那条已经不在了
       * 而重新算出自己是继承人，同一套实体牌被分两次。
       */
      event: 'BeforeDeath',
      priority: -100,
      handle(host, ownerId, context) {
        const deadId = context.event.payload.playerId as PlayerId
        if (deadId === ownerId) {
          // 牛来自己死了：只解除自己这条，别人认同一个麻麻的关系不受影响
          delete host.state.mamaBonds[ownerId]
          return
        }
        if (host.state.mamaBonds?.[ownerId] !== deadId) return
        const dead = playerOf(host.state, deadId)
        // 被救回来了就不算死亡，牌一张都不能动
        if (!dead || dead.hp > 0) return

        const heirId = heirFor(host.state, deadId)
        const orphanIds = host.state.players
          .filter((player) => host.state.mamaBonds?.[player.id] === deadId)
          .map((player) => player.id)
        // 先清关系再转牌：清空之后其余牛来的处理器会在上面那行直接返回
        for (const orphanId of orphanIds) delete host.state.mamaBonds[orphanId]
        if (heirId) inheritEstate(host, heirId, deadId)
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'pick') {
      // 排队期间可能已经在别处认过了
      if (mamaOf(host.state, ownerId)) return
      askPickMama(host, ownerId)
      return
    }
    if (prompt.step === 'follow') startFollow(host, ownerId, prompt.data)
  },

  resume(host, ownerId, resolution, response: GameResponse) {
    if (resolution.step === 'pick') {
      const [mamaId] = (response.payload as { targetIds: PlayerId[] }).targetIds
      const mama = playerOf(host.state, mamaId)
      if (!mama?.alive || mamaId === ownerId) {
        // 回答不合法：规则要求必须认，所以重新问，而不是放着不认
        askPickMama(host, ownerId)
        return
      }
      setMama(host, ownerId, mamaId)
      return
    }

    const facts = followDataOf(resolution.data)

    if (resolution.step === 'ask') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== FOLLOW && optionId !== HELP) return
      const candidateIds = followCandidates(host.state, ownerId, facts.targetIds)
      if (candidateIds.length === 0) return
      // 先记账：反复取消不能刷次数
      markUsedThisTurn(host.state, ownerId, MAMA)
      askFollowTarget(host, ownerId, { ...resolution.data, mode: optionId === FOLLOW ? 'follow' : 'help' }, candidateIds)
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
      if (!followCandidates(host.state, ownerId, facts.targetIds).includes(targetId)) return
      askFollowCards(host, ownerId, { ...resolution.data, targetId }, facts.mode)
      return
    }

    if (resolution.step === 'card') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      const owner = playerOf(host.state, ownerId)
      if (!facts.targetId || !owner?.zones.hand.includes(cardId)) return
      if (host.state.cards[cardId]?.name !== '杀') return
      fireFollowSlash(host, ownerId, facts.targetId, cardId)
      return
    }

    if (resolution.step !== 'discard') return
    const cardIds = (response.payload as { cardIds: CardId[] }).cardIds ?? []
    const discarded: CardId[] = []
    for (const cardId of cardIds) {
      const zone = locateOwnedCard(host.state, ownerId, cardId)
      if (!zone) continue
      moveCard(host.state, cardId, zone, { kind: 'discardPile' })
      discarded.push(cardId)
    }
    if (discarded.length > 0) {
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: discarded, reason: MAMA }, { targetId: ownerId, cardIds: discarded })
    }
    // 两张牌是代价，必须真的付掉；不足两张就不生成这一刀
    if (discarded.length < 2 || !facts.targetId) return
    fireFollowSlash(host, ownerId, facts.targetId, null)
  },
})

export const NIULAI_CHARACTER: CharacterDefinition = {
  id: 'niulai',
  name: '牛来',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'entertainment',
  skills: [
    {
      id: NIULAI,
      name: '牛来',
      description: '出牌阶段限一次，你展示牌堆顶的一张牌并获得之，然后你可以重复此流程。若新展示牌点数不小于上一张，你获得之；否则弃置此牌和本次以此法获得的所有牌。每次成功后，你可以结束此技能。',
    },
    {
      id: MAMA,
      name: '麻麻',
      description: '游戏开始时，你选择一名其他角色成为“麻麻”。每回合限一次，当“麻麻”使用【杀】且你不是目标时，你可以对其中一名目标使用一张无距离限制且不计次数的【杀】，或弃置两张牌视为如此使用【杀】。当“麻麻”死亡时，你获得其手牌和装备区里的牌；若你没有“麻麻”，准备阶段选择一名其他角色成为新的“麻麻”。',
    },
  ],
}
