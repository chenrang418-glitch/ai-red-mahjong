import { injectCardsIntoDeck, type InjectedCardSpec } from '../../engine/card-injection'
import {
  addRecordedName,
  canUseOnce,
  consumeOnce,
  hasRecordedName,
  recordedNames,
  removeRecordedName,
} from '../../engine/card-name-history'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { isPhysicalCardUse } from '../../engine/physical-card-use'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { PlayerId, Rank, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神荀彧。
 *
 * 【天佐】：锁定技，游戏开始时把 8 张【奇正相生】加入牌堆；【奇正相生】对他无效。
 * 【灵策】：锁定技，一名角色使用**非虚拟非转化**的锦囊牌时，若牌名属于智囊牌名、
 *   定汉已记录的牌名或【奇正相生】，他摸一张牌。
 * 【定汉】：每种牌名限一次，他成为锦囊牌的目标时记录此牌名并取消之；
 *   他的回合开始时可以在记录里增删一种锦囊牌牌名。
 *
 * 最容易做错的一处：**灵策和定汉的条件不是同一个。**
 * 灵策只认非虚拟非转化的实体锦囊；定汉的取消按「成为锦囊牌的目标」，
 * 文本没有非虚拟限制，虚拟锦囊照样能被取消。两者不要合并成一个判断。
 */

const TIANZUO = 'tianzuo'
const LINGCE = 'lingce'
const DINGHAN = 'dinghan'

/** 定汉的历史记账 key。记录集合和已用集合都挂在它下面。 */
const DINGHAN_KEY = 'dinghan'

export const QIZHENG = '奇正相生'

/**
 * 天佐加入牌堆的 8 张【奇正相生】。
 *
 * 花色点数是本项目为这张牌定下的，和基础牌堆不重叠；
 * 它们只在场上有天佐时才存在，不写进基础牌表。
 */
const QIZHENG_CARDS: readonly InjectedCardSpec[] = [
  { name: QIZHENG, suit: 'spade', rank: 2 as Rank, category: 'trick' },
  { name: QIZHENG, suit: 'spade', rank: 4 as Rank, category: 'trick' },
  { name: QIZHENG, suit: 'spade', rank: 6 as Rank, category: 'trick' },
  { name: QIZHENG, suit: 'spade', rank: 8 as Rank, category: 'trick' },
  { name: QIZHENG, suit: 'club', rank: 3 as Rank, category: 'trick' },
  { name: QIZHENG, suit: 'club', rank: 5 as Rank, category: 'trick' },
  { name: QIZHENG, suit: 'club', rank: 7 as Rank, category: 'trick' },
  { name: QIZHENG, suit: 'club', rank: 9 as Rank, category: 'trick' },
]

/**
 * 智囊牌名。
 *
 * 这是**本项目锁定的一组牌名**，不写散在技能实现里，方便以后统一调整。
 */
export const WISDOM_TRICK_NAMES: readonly string[] = ['无中生有', '无懈可击', '过河拆桥']

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 场上拥有某个技能且还活着的角色。 */
function ownersOf(state: SanguoshaState, skillId: string): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive)
    .filter((candidate) => (candidate.grantedSkills ?? []).includes(skillId)
      || (candidate.characterId === 'shenxunyu' && [TIANZUO, LINGCE, DINGHAN].includes(skillId)))
    .map((candidate) => candidate.id)
}

// ─────────────────────────────── 天佐 ───────────────────────────────

registerSkillRuntime({
  id: TIANZUO,
  onGameStart(host, ownerId) {
    /*
     * 加进去的是**真牌**：能被摸到、使用、弃置、洗回牌堆，全程参与牌张守恒。
     * id 带上拥有者，娱乐模式里两个神荀彧各加 8 张也不会撞。
     * 神荀彧死了这些牌**不会消失**——它们已经是这局牌堆的一部分。
     */
    const created = injectCardsIntoDeck(host as never, QIZHENG_CARDS, `${TIANZUO}-${ownerId}`)
    host.dispatch('SkillActivated', {
      skillId: TIANZUO, skillName: '天佐', playerId: ownerId,
      logText: `${playerOf(host.state, ownerId)?.nickname}发动【天佐】，将 ${created.length} 张【${QIZHENG}】加入牌堆`,
    }, { sourceId: ownerId })
  },
  /**
   * 【奇正相生】对他无效。
   *
   * 这是**效果无效**，不是禁止指定目标：他仍然可以成为目标，
   * 只是不会被要求打杀/闪，也不会挨伤害或被拿牌。
   */
  cardEffectInvalid(state, targetId, _sourceId, cardName) {
    if (cardName !== QIZHENG) return false
    const target = playerOf(state, targetId)
    return !!target && target.characterId === 'shenxunyu'
  },
})

// ─────────────────────────────── 灵策 ───────────────────────────────

/**
 * 这张牌算不算「非虚拟、非转化的实体锦囊」。
 *
 * 「非虚拟非转化」的口径和神太史慈【神著】是同一条，收在公共的
 * `isPhysicalCardUse` 里；这里只额外要求它是锦囊。
 */
function isPhysicalTrick(state: SanguoshaState, cardId: string, effectiveName: string): boolean {
  if (!isPhysicalCardUse(state, cardId, effectiveName)) return false
  return state.cards[cardId]?.category === 'trick'
}

registerSkillRuntime({
  id: LINGCE,
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: string; cardName?: string }
      const cardId = payload.cardId
      const cardName = payload.cardName
      if (!cardId || !cardName) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      /*
       * **只认实体原生锦囊。**
       * 佐幸印出来的虚拟锦囊、火计转化的火攻、蛊惑声明的锦囊都不算——
       * 哪怕生效名字对得上也不触发。
       */
      if (!isPhysicalTrick(host.state, cardId, cardName)) return
      const matches = WISDOM_TRICK_NAMES.includes(cardName)
        || cardName === QIZHENG
        || hasRecordedName(host.state, ownerId, DINGHAN_KEY, cardName)
      if (!matches) return
      host.dispatch('SkillActivated', {
        skillId: LINGCE, skillName: '灵策', playerId: ownerId,
        logText: `${owner.nickname}发动【灵策】，摸一张牌`,
      }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    },
  }],
})

// ─────────────────────────────── 定汉 ───────────────────────────────

registerSkillRuntime({
  id: DINGHAN,
  /*
   * 成为锦囊牌的目标时记录并取消。
   *
   * 走 `cancelsBecomingTarget` 而不是 `TargetConfirmed` 触发：
   * 那个事件是在 `cardResolution` 建立**之前**派发的，那时候既读不到结算状态，
   * 也没有 `cancelledTargetIds` 可写，挂在上面等于永远不生效。
   * 何况延时锦囊压根不产生 `cardResolution`。
   *
   * 取消的**只是他这一个目标**，多目标锦囊的其余角色照常结算。
   * 条件里没有「非虚拟」，所以虚拟锦囊也能被取消——这和灵策的口径不同。
   */
  cancelsBecomingTarget(host, ownerId, context) {
    if (context.category !== 'trick') return false
    const cardName = context.cardName
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    // 每种牌名限一次，看的是整局历史，不是当前记录里还有没有
    if (!canUseOnce(host.state, ownerId, DINGHAN_KEY, cardName)) return false

    consumeOnce(host.state, ownerId, DINGHAN_KEY, cardName)
    addRecordedName(host.state, ownerId, DINGHAN_KEY, cardName)
    host.dispatch('SkillActivated', {
      skillId: DINGHAN, skillName: '定汉', playerId: ownerId,
      logText: `${owner.nickname}发动【定汉】，记录【${cardName}】并取消自己这个目标`,
    }, { sourceId: ownerId })
    return true
  },
  triggers: [
    {
      /*
       * 自己的回合开始时，可以在记录里增删一种锦囊牌牌名。
       *
       * **排队发问，不当场挂请求。** 同一个 `TurnStart` 上可能还有别的技能
       * 要发问（神太史慈【破围】就挂在这个时机），两个技能同时 `askSkill`
       * 会撞上「已有技能正在等待回应」。排队交给引擎在场面干净时逐个放出来。
       */
      event: 'TurnStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.queueSkill({ skillId: DINGHAN, ownerId, step: 'maintain', data: {} })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'maintain') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    // 排队期间局势会变，候选要在真正发问的这一刻重算
    const recorded = [...recordedNames(host.state, ownerId, DINGHAN_KEY)]
    const addable = [...INSTANT_TRICKS, ...DELAYED_TRICK_NAMES].filter((name) => !recorded.includes(name))
    if (recorded.length === 0 && addable.length === 0) return
    host.askSkill({
      skillId: DINGHAN,
      ownerId,
      step: 'maintain',
      build: (requestId) => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【定汉】：当前记录 ${recorded.length ? recorded.join('、') : '（空）'}`,
        timeoutMs: 25_000, optional: true,
        options: [
          ...addable.map((name) => ({ id: `add:${name}`, label: `记录【${name}】` })),
          ...recorded.map((name) => ({ id: `remove:${name}`, label: `移除【${name}】` })),
          { id: 'skip', label: '不做改动' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'maintain') return
    const optionId = (response.payload as { optionId?: string }).optionId ?? 'skip'
    if (optionId === 'skip') return
    const [action, name] = [optionId.slice(0, optionId.indexOf(':')), optionId.slice(optionId.indexOf(':') + 1)]
    if (!name) return
    if (action === 'add') {
      /*
       * **手动记录不消耗首次取消资格。**
       * 这里只动 `recorded`，不碰 `used`——两者分开正是为了这一条。
       */
      addRecordedName(host.state, ownerId, DINGHAN_KEY, name)
    } else if (action === 'remove') {
      // 移除记录同样不退还资格：`used` 只增不减
      removeRecordedName(host.state, ownerId, DINGHAN_KEY, name)
    } else return
    host.dispatch('SkillActivated', {
      skillId: DINGHAN, skillName: '定汉', playerId: ownerId,
      logText: `${playerOf(host.state, ownerId)?.nickname}发动【定汉】，${action === 'add' ? '记录' : '移除'}【${name}】`,
    }, { sourceId: ownerId })
  },
})

/** 延时锦囊也能被定汉记录：文本说的是「锦囊牌」，没有限定普通锦囊。 */
const DELAYED_TRICK_NAMES = ['乐不思蜀', '兵粮寸断', '闪电'] as const

export const SHENXUNYU: CharacterDefinition = {
  id: 'shenxunyu',
  name: '神·荀彧',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 3,
  pack: 'god',
  skills: [
    {
      id: TIANZUO,
      name: '天佐',
      description: '锁定技，游戏开始时，将8张【奇正相生】加入牌堆。【奇正相生】对你无效。',
    },
    {
      id: LINGCE,
      name: '灵策',
      description: '锁定技。一名角色使用非虚拟非转化的锦囊牌时，若此牌的牌名属于智囊牌名、「定汉」已记录的牌名或【奇正相生】时，你摸一张牌。',
    },
    {
      id: DINGHAN,
      name: '定汉',
      description: '每种牌名限一次，你成为锦囊牌的目标时，你记录此牌名，然后取消之。你的回合开始时，你可以在「定汉」记录中，增加或移除一种锦囊牌牌名。',
    },
  ],
}

export { ownersOf }
