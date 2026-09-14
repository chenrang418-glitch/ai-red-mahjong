import { moveCard } from '../../engine/zones'
import { loseHp } from '../../engine/hp'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 朱建平（三国杀《一将成名》官方当前版本）。
 *
 * 【相面】：出牌阶段限一次，选择一名其他角色A（每名角色本局限一次）进行
 *          判定，记录判定花色S和点数N，建立持续诅咒：A使用效果花色为S的
 *          牌后，或A本回合使用的第N张牌后，A失去所有体力。
 * 【天机】：锁定技，一张判定牌生效后，你从牌堆中随机获得与其类别相同、
 *          花色相同、点数相同的牌各1张（不重复取得同一张实体牌）。
 */

const XIANGMIAN = 'xiangmian'
const TIANJI = 'tianji'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: XIANGMIAN,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(XIANGMIAN)) return []
    const used = new Set(state.xiangmianUsed ?? [])
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && !used.has(candidate.id))) return []
    return [{ id: XIANGMIAN, label: '相面：选择一名未被相面过的其他角色进行判定' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== XIANGMIAN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(XIANGMIAN)) return
    const used = new Set(host.state.xiangmianUsed ?? [])
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && !used.has(candidate.id)).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    owner.turnUsedSkills.push(XIANGMIAN)
    host.askSkill({
      skillId: XIANGMIAN, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【相面】：选择一名未被相面过的其他角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    host.state.xiangmianUsed = [...(host.state.xiangmianUsed ?? []), targetId]
    host.dispatch('SkillActivated', { skillId: XIANGMIAN, skillName: '相面', playerId: ownerId, targetId, logText: `${owner.nickname}发动【相面】` }, { sourceId: ownerId, targetId })
    performJudgment(host, targetId, XIANGMIAN, { tag: XIANGMIAN, data: { ownerId, targetId } })
  },
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      if (!sourceId) return
      const curse = host.state.xiangmianCurse?.[sourceId]
      if (!curse || curse.ownerId !== ownerId) return
      const source = playerOf(host.state, sourceId)
      if (!source?.alive) return
      if (source.marks['xiangmian-seq-turn'] !== host.state.turnNumber) { source.marks['xiangmian-seq-turn'] = host.state.turnNumber; source.marks['xiangmian-seq'] = 0 }
      source.marks['xiangmian-seq'] = (source.marks['xiangmian-seq'] ?? 0) + 1
      const payload = context.event.payload as { cardId?: CardId }
      const suit = payload.cardId ? host.state.cards[payload.cardId]?.suit : undefined
      const suitHit = suit === curse.suit
      const seqHit = source.marks['xiangmian-seq'] === curse.rank
      if (!suitHit && !seqHit) return
      delete host.state.xiangmianCurse![sourceId]
      host.dispatch('SkillActivated', { skillId: XIANGMIAN, skillName: '相面', playerId: ownerId, targetId: sourceId, logText: `${source.nickname}触发【相面】诅咒，失去所有体力` }, { sourceId: ownerId, targetId: sourceId })
      /*
       * CardUsed 在这张牌自己的结算刚开始时就派发（目标还没问过闪），
       * 这里直接 loseHp 可能让其进入濒死，和外层这张牌的结算撞在一起
       * （已知 bug 类型：seed=sp16-sub5-5-0）。推迟到 AfterCardUse 之后。
       */
      host.state.xiangmianPendingLoss = { ownerId, sourceId }
    },
  }, {
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const pending = host.state.xiangmianPendingLoss
      if (!pending || pending.ownerId !== ownerId || context.event.sourceId !== pending.sourceId) return
      host.state.xiangmianPendingLoss = undefined
      const source = playerOf(host.state, pending.sourceId)
      if (source?.alive && source.hp > 0) loseHp(host as never, pending.sourceId, source.hp, XIANGMIAN)
    },
  }],
})

registerJudgmentContinuation(XIANGMIAN, (host, judged, data) => {
  const { ownerId, targetId } = data as { ownerId: PlayerId; targetId: PlayerId }
  host.state.xiangmianCurse = { ...(host.state.xiangmianCurse ?? {}), [targetId]: { ownerId, suit: judged.suit, rank: judged.rank } }
})

registerSkillRuntime({
  id: TIANJI,
  triggers: [{
    event: 'JudgeResult',
    handle(host, ownerId, context) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const payload = context.event.payload as { judgeCardId?: CardId; suit?: string; rank?: number }
      const judgeCard = payload.judgeCardId ? host.state.cards[payload.judgeCardId] : undefined
      if (!judgeCard || !payload.suit || !payload.rank) return
      const taken = new Set<CardId>()
      const gained: CardId[] = []
      const pickOne = (predicate: (id: CardId) => boolean): void => {
        const pool = host.state.zones.drawPile.filter((id) => !taken.has(id) && predicate(id))
        if (pool.length === 0) return
        const cardId = pool[host.rng.nextInt(pool.length)]
        taken.add(cardId)
        gained.push(cardId)
      }
      pickOne((id) => host.state.cards[id]?.category === judgeCard.category)
      pickOne((id) => host.state.cards[id]?.suit === payload.suit)
      pickOne((id) => host.state.cards[id]?.rank === payload.rank)
      if (gained.length === 0) return
      for (const cardId of gained) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: TIANJI }, { targetId: ownerId, cardIds: gained })
      host.dispatch('SkillActivated', { skillId: TIANJI, skillName: '天机', playerId: ownerId, logText: `${owner.nickname}发动【天机】，获得${gained.length}张牌` }, { sourceId: ownerId })
    },
  }],
})

export const ZHUJIANPING: CharacterDefinition = {
  id: 'zhujianping',
  name: '朱建平',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: XIANGMIAN, name: '相面', description: '出牌阶段限一次，选择一名其他角色（每名角色本局限一次）进行判定，记录判定花色和点数，建立持续诅咒：其使用效果花色相同的牌后，或其本回合使用的第N张牌后（N为判定点数），其失去所有体力。' },
    { id: TIANJI, name: '天机', description: '锁定技，一张判定牌生效后，你从牌堆中随机获得与其类别相同、花色相同、点数相同的牌各1张（不重复取得同一张实体牌）。' },
  ],
}
