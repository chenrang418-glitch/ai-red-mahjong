import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { recover } from '../../engine/recover'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { loseHp } from '../../engine/hp'
import { drawCards } from '../../engine/draw'
import { getSkillRuntime as skillRuntimeOf, provideBorrowableSkillLookup, provideCharacterClanLookup, provideSkillIdsLookup, registerSkillRuntime, skillsOf, type ViewAsOption } from '../../engine/skills/runtime'
import { provideLockedSkillLookup } from '../../engine/locked-skills'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'
import { effectiveGenderOf, provideHuashenCharacterCatalog } from '../../engine/huashen'
import { provideGeneralFactionLookup } from '../../engine/general-slots'
import { provideCharacterPool } from '../../engine/character-pool'
import { provideRandomSkillPool } from '../../engine/random-skill-pool'
import { WEI_CHARACTERS } from './wei'
import { WEI_DAMAGE_CHARACTERS } from './wei-damage'
import { LORD_CHARACTERS, provideKingdomLookup } from './lords'
import { QUN_CHARACTERS } from './qun'
import { SHU_CHARACTERS } from './shu'
import { WU_CHARACTERS } from './wu'
import { WIND_CHARACTERS } from './wind'
import { FIRE_CHARACTERS } from './fire'
import { FOREST_CHARACTERS } from './forest'
import { MOUNTAIN_CHARACTERS } from './mountain'
import { GOD_CHARACTERS } from './god'
import { YJCM2011_CHARACTERS } from './yjcm2011'
import { YJCM2012_CHARACTERS } from './yjcm2012'
import { YJCM2013_CHARACTERS } from './yjcm2013'
import { YJCM2014_CHARACTERS } from './yjcm2014'
import { YJCM2015_CHARACTERS } from './yjcm2015'
import { SP_CHARACTERS } from './sp'
import { JIN_CHARACTERS } from './jin'
import { JIN2_CHARACTERS } from './jin2'
import { WEI_JIN_HISTORICAL_CHARACTERS } from './wei-jin-historical'
import { HISTORICAL_BATCH19_CHARACTERS } from './historical-batch19'
import { HISTORICAL_BATCH20_CHARACTERS } from './historical-batch20'
import { HISTORICAL_BATCH21_CHARACTERS } from './historical-batch21'
import { HISTORICAL_BATCH22_CHARACTERS } from './historical-batch22'
import { HISTORICAL_BATCH23_CHARACTERS } from './historical-batch23'
import { HISTORICAL_BATCH24_CHARACTERS } from './historical-batch24'
import { HISTORICAL_BATCH25_CHARACTERS } from './historical-batch25'
import { HISTORICAL_BATCH26_CHARACTERS } from './historical-batch26'
import { HISTORICAL_BATCH27_CHARACTERS } from './historical-batch27'
import { HISTORICAL_BATCH28_CHARACTERS } from './historical-batch28'
import { HISTORICAL_BATCH29_CHARACTERS } from './historical-batch29'
import { HISTORICAL_BATCH30_CHARACTERS } from './historical-batch30'
import { HISTORICAL_BATCH31_CHARACTERS } from './historical-batch31'
import { LIUZHANG_B34, MOU_GONGSUNZAN_B34, MOU_LIUCHENG_B34, MOUYUANSHAO_B34, PANGXI_B34, SHI_HUANGZU_B34, SHI_SUNCHEN_B34, SHI_TAISHICI_B34, SIMAZHAO_SP_B34, WUKE_B34 } from './historical-batch32'
import { LAIMIN_B35, LIFENG_B35, LIRU_JIE_B35, MAJUN_B35, MALIANG_B35, MIFUREN_B35, PANGDEGONG_B35, PANZHANG_MAZHONG_JIE_B35, YANBAIHU_B35, ZERONG_B35 } from './historical-batch33'
import { HISTORICAL_BATCH34_CHARACTERS } from './historical-batch34'
import { HISTORICAL_BATCH35_CHARACTERS } from './historical-batch35'
import { HISTORICAL_BATCH36_CHARACTERS } from './historical-batch36'
import { HISTORICAL_BATCH37_CHARACTERS } from './historical-batch37'
import { HISTORICAL_BATCH38_CHARACTERS } from './historical-batch38'
import { HISTORICAL_BATCH39_CHARACTERS } from './historical-batch39'
import { HISTORICAL_BATCH40_CHARACTERS } from './historical-batch40'
import { HISTORICAL_BATCH41_CHARACTERS } from './historical-batch41'
import { HISTORICAL_BATCH42_CHARACTERS } from './historical-batch42'
import { HISTORICAL_BATCH43_CHARACTERS } from './historical-batch43'
import { HISTORICAL_BATCH45_PART1, HISTORICAL_BATCH45_PART2 } from './historical-batch45'
import { HISTORICAL_BATCH46_PART1, HISTORICAL_BATCH46_PART2 } from './historical-batch46'
import { HISTORICAL_BATCH47_CHARACTERS } from './historical-batch47'
import { HISTORICAL_BATCH48_CHARACTERS } from './historical-batch48'
import { HISTORICAL_BATCH49_CHARACTERS } from './historical-batch49'
import { HISTORICAL_BATCH50_CHARACTERS } from './historical-batch50'
import { HISTORICAL_BATCH51_CHARACTERS } from './historical-batch51'
import { HISTORICAL_BATCH52_CHARACTERS } from './historical-batch52'
import { HISTORICAL_BATCH53_CHARACTERS } from './historical-batch53'
import { HISTORICAL_BATCH54_CHARACTERS } from './historical-batch54'
import { HISTORICAL_BATCH55_CHARACTERS } from './historical-batch55'
import { HISTORICAL_BATCH56_CHARACTERS } from './historical-batch56'
import { HISTORICAL_BATCH57_CHARACTERS } from './historical-batch57'
import { HISTORICAL_BATCH58_CHARACTERS } from './historical-batch58'
import { HISTORICAL_BATCH59_CHARACTERS } from './historical-batch59'
import { HISTORICAL_BATCH60_CHARACTERS } from './historical-batch60'
import { HISTORICAL_BATCH61_CHARACTERS } from './historical-batch61'
import { HISTORICAL_BATCH62_CHARACTERS } from './historical-batch62'
import { HISTORICAL_BATCH63_CHARACTERS } from './historical-batch63'
import { HISTORICAL_BATCH64_CHARACTERS } from './historical-batch64'
import { HISTORICAL_BATCH65_CHARACTERS } from './historical-batch65'
import { HISTORICAL_BATCH66_CHARACTERS } from './historical-batch66'
import { HISTORICAL_BATCH67_CHARACTERS } from './historical-batch67'
import { HISTORICAL_BATCH68_CHARACTERS } from './historical-batch68'
import { HISTORICAL_BATCH69_CHARACTERS } from './historical-batch69'
import { HISTORICAL_BATCH70_CHARACTERS } from './historical-batch70'
import { HISTORICAL_BATCH71_CHARACTERS } from './historical-batch71'
import { HISTORICAL_BATCH72_CHARACTERS } from './historical-batch72'
import { HISTORICAL_BATCH73_CHARACTERS } from './historical-batch73'
import { HISTORICAL_BATCH74_CHARACTERS } from './historical-batch74'
import { HISTORICAL_BATCH75_CHARACTERS } from './historical-batch75'
import { HISTORICAL_BATCH76_CHARACTERS } from './historical-batch76'
import { HISTORICAL_BATCH77_CHARACTERS } from './historical-batch77'
import { HISTORICAL_BATCH78_CHARACTERS } from './historical-batch78'
import { HISTORICAL_BATCH79_CHARACTERS } from './historical-batch79'
import { HISTORICAL_BATCH80_CHARACTERS } from './historical-batch80'
import { HISTORICAL_BATCH81_CHARACTERS } from './historical-batch81'
import { HISTORICAL_BATCH82_CHARACTERS } from './historical-batch82'
import { HISTORICAL_BATCH83_CHARACTERS } from './historical-batch83'
import { HISTORICAL_BATCH84_CHARACTERS } from './historical-batch84'
import { HISTORICAL_BATCH85_CHARACTERS } from './historical-batch85'
import { HISTORICAL_BATCH86_CHARACTERS } from './historical-batch86'
import { HISTORICAL_BATCH87_CHARACTERS } from './historical-batch87'
import { HISTORICAL_BATCH88_CHARACTERS } from './historical-batch88'
import { HISTORICAL_BATCH89_CHARACTERS } from './historical-batch89'
import { HISTORICAL_BATCH90_CHARACTERS } from './historical-batch90'
import { FLASH_BATCH91_CHARACTERS } from './flash-batch91'
import { FENGJI_2026 } from './fengji-2026'
import { ENTERTAINMENT_CHARACTERS } from './entertainment'

/**
 * 标准包武将。
 *
 * **只登记技能已经完整实现的武将。**任务书明令禁止「选将页看得到、技能其实没写」，
 * 所以这个数组就是「真的能玩」的清单，其余 21 将等实现完再加进来。
 *
 * 技能说明只在这里写一份，规则页直接读它，不另外维护副本。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

// —— 张飞【咆哮】——
registerSkillRuntime({
  id: 'paoxiao',
  // 锁定技，走和诸葛连弩同一个入口，不另写一套出杀次数逻辑
  unlimitedSlash: true,
})

// —— 马超【马术】——
registerSkillRuntime({
  id: 'mashu',
  // 距离修正只报数值，真正的计算仍然在 distance.ts 里
  distanceModifier: { toOthers: -1 },
})

// —— 关羽【武圣】——
registerSkillRuntime({
  id: 'wusheng',
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    const options: ViewAsOption[] = []
    for (const cardId of owner.zones.hand) {
      const card = state.cards[cardId]
      // 已经是杀的牌不需要转化；红色的其他牌才走武圣
      if (!card || card.color !== 'red' || card.name === '杀') continue
      options.push({ asCardName: '杀', cardId, label: `将【${card.name}】当【杀】使用` })
    }
    return options
  },
})

// —— 赵云【龙胆】——
registerSkillRuntime({
  id: 'longdan',
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    const options: ViewAsOption[] = []
    for (const cardId of owner.zones.hand) {
      const card = state.cards[cardId]
      if (!card) continue
      // 龙胆是双向的，两个方向都要报出来：
      // 出牌阶段的动作生成只取 asCardName === '杀'，
      // 求闪时 dodgeViewAsOptions 只取 asCardName === '闪'，各取所需。
      if (card.name === '闪') options.push({ asCardName: '杀', cardId, label: '将【闪】当【杀】使用' })
      else if (card.name === '杀') options.push({ asCardName: '闪', cardId, label: '将【杀】当【闪】打出' })
    }
    return options
  },
})

// —— 甄姬【倾国】——
registerSkillRuntime({
  id: 'qingguo',
  viewAs(state, ownerId): ViewAsOption[] {
    return playerOf(state, ownerId).zones.hand
      .filter((cardId) => state.cards[cardId]?.color === 'black')
      .map((cardId) => ({ asCardName: '闪', cardId, label: `将【${state.cards[cardId].name}】当【闪】使用或打出` }))
  },
})

// —— 华佗【急救】——
registerSkillRuntime({
  id: 'jijiu',
  viewAs(state, ownerId): ViewAsOption[] {
    if (state.currentPlayerId === ownerId) return []
    return playerOf(state, ownerId).zones.hand
      .filter((cardId) => state.cards[cardId]?.color === 'red')
      .map((cardId) => ({ asCardName: '桃', cardId, label: `将【${state.cards[cardId].name}】当【桃】使用` }))
  },
})

// —— 黄月英【集智】【奇才】——
registerSkillRuntime({
  id: 'jizhi',
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: string; cardName?: string }
      if (context.event.sourceId !== ownerId) return
      const cardId = payload.cardId
      if (!cardId) return
      // 只对非延时锦囊生效；延时锦囊放进判定区，不算「使用锦囊」触发集智
      const card = host.state.cards[cardId]
      if (!card || card.category !== 'trick') return
      if (DELAYED_TRICK_NAMES.has(card.name)) return
      const owner = host.state.players.find((candidate) => candidate.id === ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: 'jizhi', ownerId, step: 'draw', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'draw') return
    const owner = host.state.players.find((candidate) => candidate.id === ownerId && candidate.alive)
    if (!owner) return
    host.askSkill({
      skillId: 'jizhi', ownerId, step: 'draw', data: {},
      build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【集智】：是否摸一张牌？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '摸一张牌' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'draw' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    if (!host.state.players.some((candidate) => candidate.id === ownerId && candidate.alive)) return
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
  },
})

registerSkillRuntime({
  id: 'qicai',
  // 锁定技：使用锦囊无视距离。走统一入口，锦囊自己不重算距离。
  ignoresTrickDistance: true,
})

const DELAYED_TRICK_NAMES = new Set(['乐不思蜀', '兵粮寸断', '闪电'])


// —— 甘宁【奇袭】——
registerSkillRuntime({
  id: 'qixi',
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    const options: ViewAsOption[] = []
    for (const cardId of owner.zones.hand) {
      const card = state.cards[cardId]
      if (!card || card.color !== 'black' || card.name === '过河拆桥') continue
      options.push({ asCardName: '过河拆桥', cardId, label: `将【${card.name}】当【过河拆桥】使用` })
    }
    return options
  },
})

// —— 黄盖【苦肉】——
registerSkillRuntime({
  id: 'kurou',
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    // 体力只剩一点时发动会直接进濒死，规则允许，但 AI 不该主动送——交给 AI 评估
    if (!owner.alive || owner.hp <= 0) return []
    return [{ id: 'skill:kurou', label: '发动【苦肉】：失去一点体力，摸两张牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:kurou') throw new Error('苦肉动作不匹配')
    // 苦肉是失去体力而不是受到伤害。若因此进入濒死，先让求桃结算完成再续接摸牌。
    const owner = playerOf(host.state, ownerId)
    loseHp(host, ownerId, 1, '苦肉')
    if (owner.alive) host.queueSkill({ skillId: 'kurou', ownerId, step: 'draw', data: {} })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'draw' || !playerOf(host.state, ownerId).alive) return
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
  },
})

// —— 孙尚香【枭姬】——
registerSkillRuntime({
  id: 'xiaoji',
  triggers: [{
    event: 'LoseEquipment',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: string }
      if (payload.playerId !== ownerId) return
      const owner = host.state.players.find((candidate) => candidate.id === ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: 'xiaoji', ownerId, step: 'draw', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'draw') return
    if (!host.state.players.some((candidate) => candidate.id === ownerId && candidate.alive)) return
    host.askSkill({
      skillId: 'xiaoji', ownerId, step: 'draw', data: {},
      build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【枭姬】：是否摸两张牌？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '摸两张牌' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'draw' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    if (!host.state.players.some((candidate) => candidate.id === ownerId && candidate.alive)) return
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
  },
})

// —— 孙尚香【结姻】——
registerSkillRuntime({
  id: 'jieyin',
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner.alive || owner.zones.hand.length < 2 || usedThisTurn(state, ownerId, 'jieyin')) return []
    const hasTarget = state.players.some((target) => (
      target.alive && target.id !== ownerId && target.hp < target.maxHp
      && target.characterId !== null && effectiveGenderOf(state, target.id) === 'male'
    ))
    return hasTarget ? [{ id: 'skill:jieyin', label: '发动【结姻】：弃置两张手牌，与一名受伤男性角色各回复一点体力' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:jieyin') throw new Error('结姻动作不匹配')
    const owner = playerOf(host.state, ownerId)
    host.askSkill({
      skillId: 'jieyin', ownerId, step: 'discard',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【结姻】：弃置两张手牌',
        timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 2, max: 2,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard') {
      const cardIds = (response.payload as { cardIds: CardId[] }).cardIds
      const owner = playerOf(host.state, ownerId)
      if (cardIds.some((cardId) => !owner.zones.hand.includes(cardId))) throw new Error('结姻弃牌不属于技能拥有者')
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: '结姻' }, { sourceId: ownerId, cardIds })
      const candidateIds = host.state.players.filter((target) => (
        target.alive && target.id !== ownerId && target.hp < target.maxHp
        && target.characterId !== null && effectiveGenderOf(host.state, target.id) === 'male'
      )).map((target) => target.id)
      host.askSkill({
        skillId: 'jieyin', ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '选择【结姻】的受伤男性角色',
          timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
    markUsedThisTurn(host.state, ownerId, 'jieyin')
    recover(host, targetId, 1, ownerId)
    recover(host, ownerId, 1, ownerId)
  },
})

/** 在响应锦囊或基本牌时，哪些手牌可以转化成指定牌名。 */
export function responseViewAsOptions(state: SanguoshaState, playerId: PlayerId, requiredCardName: string): ViewAsOption[] {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player?.characterId) return []
  const own = skillsOf(state, playerId, skillIdsOf)
    .flatMap((runtime) => runtime.viewAs?.(state, playerId) ?? [])
    .filter((option) => option.asCardName === requiredCardName)
  const granted = state.players.filter((owner) => owner.alive && owner.id !== playerId)
    .flatMap((owner) => skillsOf(state, owner.id, skillIdsOf)
      .flatMap((runtime) => runtime.globalResponseViewAs?.(state, owner.id, playerId, requiredCardName) ?? []))
  return [...own, ...granted].filter((option) => option.asCardName === requiredCardName)
}

/** 需要打出【闪】时，哪些手牌可以转化成【闪】。 */
export function dodgeViewAsOptions(state: SanguoshaState, playerId: PlayerId): ViewAsOption[] {
  return responseViewAsOptions(state, playerId, '闪')
}

export const STANDARD_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'zhangfei',
    name: '张飞',
    kingdom: 'shu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'paoxiao', name: '咆哮', qiexie: true, description: '锁定技，你使用【杀】没有次数限制。' }],
  },
  {
    id: 'machao',
    name: '马超',
    kingdom: 'shu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [
      { id: 'mashu', name: '马术', description: '锁定技，你计算与其他角色的距离时，始终减一。' },
      { id: 'tieji', name: '铁骑', qiexie: true, description: '当你使用【杀】指定一个目标后，你可以进行判定，若结果为红色，该角色不能使用【闪】响应此【杀】。' },
    ],
  },
  {
    id: 'guanyu',
    name: '关羽',
    kingdom: 'shu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'wusheng', name: '武圣', qiexie: true, description: '你可以将一张红色牌当【杀】使用或打出。' }],
  },
  {
    id: 'huangyueying',
    name: '黄月英',
    kingdom: 'shu',
    gender: 'female',
    maxHp: 3,
    pack: 'standard',
    skills: [
      { id: 'jizhi', name: '集智', description: '每当你使用一张非延时类锦囊牌时，你可以摸一张牌。' },
      { id: 'qicai', name: '奇才', description: '锁定技，你使用锦囊牌无距离限制。' },
    ],
  },
  {
    id: 'ganning',
    name: '甘宁',
    kingdom: 'wu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'qixi', name: '奇袭', description: '你可以将一张黑色牌当【过河拆桥】使用。' }],
  },
  {
    id: 'huanggai',
    name: '黄盖',
    kingdom: 'wu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'kurou', name: '苦肉', description: '出牌阶段，你可以失去一点体力，然后摸两张牌。' }],
  },
  {
    id: 'sunshangxiang',
    name: '孙尚香',
    kingdom: 'wu',
    gender: 'female',
    maxHp: 3,
    pack: 'standard',
    skills: [
      { id: 'jieyin', name: '结姻', description: '出牌阶段限一次，你可以弃置两张手牌并选择一名已受伤的男性角色，你与其各回复一点体力。' },
      { id: 'xiaoji', name: '枭姬', description: '每当你失去一张装备区里的牌时，你可以摸两张牌。' },
    ],
  },
  {
    id: 'zhaoyun',
    name: '赵云',
    kingdom: 'shu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [{ id: 'longdan', name: '龙胆', qiexie: true, description: '你可以将【杀】当【闪】、将【闪】当【杀】使用或打出。' }],
  },
  // 需要向玩家发问的技能单独放一个文件，那里的注释解释了哪些时机还不能安全挂起
  ...WEI_CHARACTERS,
  // 「受到伤害后」触发的技能走延后发问队列，原因见 wei-damage.ts 顶部
  ...WEI_DAMAGE_CHARACTERS,
  // 带主公技的武将；主公技只在坐主公位时生效
  ...LORD_CHARACTERS,
  ...QUN_CHARACTERS,
  ...SHU_CHARACTERS,
  ...WU_CHARACTERS,
] as const

/**
 * 真正可用的武将池 = 标准包 + 已完成的扩展包。
 *
 * **`STANDARD_CHARACTERS` 只装标准包**，不要往里塞扩展包武将——
 * 名字和内容对不上是最容易让人误判池子大小的一类错误。
 * 候选池、规则页、AI、立绘 manifest 一律读这个 `ALL_CHARACTERS`。
 */
export const ALL_CHARACTERS: readonly CharacterDefinition[] = [
  ...STANDARD_CHARACTERS,
  ...WIND_CHARACTERS,
  ...FIRE_CHARACTERS,
  ...FOREST_CHARACTERS,
  ...MOUNTAIN_CHARACTERS,
  ...GOD_CHARACTERS,
  ...YJCM2011_CHARACTERS,
  ...YJCM2012_CHARACTERS,
  ...YJCM2013_CHARACTERS,
  ...YJCM2014_CHARACTERS,
  ...YJCM2015_CHARACTERS,
  ...SP_CHARACTERS,
  ...JIN_CHARACTERS,
  ...JIN2_CHARACTERS,
  ...WEI_JIN_HISTORICAL_CHARACTERS,
  ...HISTORICAL_BATCH19_CHARACTERS,
  ...HISTORICAL_BATCH20_CHARACTERS,
  ...HISTORICAL_BATCH21_CHARACTERS,
  ...HISTORICAL_BATCH22_CHARACTERS,
  ...HISTORICAL_BATCH23_CHARACTERS,
  ...HISTORICAL_BATCH24_CHARACTERS,
  ...HISTORICAL_BATCH25_CHARACTERS,
  ...HISTORICAL_BATCH26_CHARACTERS,
  ...HISTORICAL_BATCH27_CHARACTERS,
  ...HISTORICAL_BATCH28_CHARACTERS,
  ...HISTORICAL_BATCH29_CHARACTERS,
  ...HISTORICAL_BATCH30_CHARACTERS,
  ...HISTORICAL_BATCH31_CHARACTERS,
  WUKE_B34,
  LIUZHANG_B34,
  MOU_LIUCHENG_B34,
  SIMAZHAO_SP_B34,
  MOUYUANSHAO_B34,
  SHI_TAISHICI_B34,
  SHI_SUNCHEN_B34,
  MOU_GONGSUNZAN_B34,
  PANGXI_B34,
  SHI_HUANGZU_B34,
  ZERONG_B35,
  MIFUREN_B35,
  LIRU_JIE_B35,
  MAJUN_B35,
  PANZHANG_MAZHONG_JIE_B35,
  PANGDEGONG_B35,
  LIFENG_B35,
  YANBAIHU_B35,
  LAIMIN_B35,
  MALIANG_B35,
  ...HISTORICAL_BATCH34_CHARACTERS,
  ...HISTORICAL_BATCH35_CHARACTERS,
  ...HISTORICAL_BATCH36_CHARACTERS,
  ...HISTORICAL_BATCH37_CHARACTERS,
  ...HISTORICAL_BATCH38_CHARACTERS,
  ...HISTORICAL_BATCH39_CHARACTERS,
  ...HISTORICAL_BATCH40_CHARACTERS,
  ...HISTORICAL_BATCH41_CHARACTERS,
  ...HISTORICAL_BATCH42_CHARACTERS,
  ...HISTORICAL_BATCH43_CHARACTERS,
  ...HISTORICAL_BATCH45_PART1,
  ...HISTORICAL_BATCH45_PART2,
  ...HISTORICAL_BATCH46_PART1,
  ...HISTORICAL_BATCH46_PART2,
  ...HISTORICAL_BATCH47_CHARACTERS,
  ...HISTORICAL_BATCH48_CHARACTERS,
  ...HISTORICAL_BATCH49_CHARACTERS,
  ...HISTORICAL_BATCH50_CHARACTERS,
  ...HISTORICAL_BATCH51_CHARACTERS,
  ...HISTORICAL_BATCH52_CHARACTERS,
  ...HISTORICAL_BATCH53_CHARACTERS,
  ...HISTORICAL_BATCH54_CHARACTERS,
  ...HISTORICAL_BATCH55_CHARACTERS,
  ...HISTORICAL_BATCH56_CHARACTERS,
  ...HISTORICAL_BATCH57_CHARACTERS,
  ...HISTORICAL_BATCH58_CHARACTERS,
  ...HISTORICAL_BATCH59_CHARACTERS,
  ...HISTORICAL_BATCH60_CHARACTERS,
  ...HISTORICAL_BATCH61_CHARACTERS,
  ...HISTORICAL_BATCH62_CHARACTERS,
  ...HISTORICAL_BATCH63_CHARACTERS,
  ...HISTORICAL_BATCH64_CHARACTERS,
  ...HISTORICAL_BATCH65_CHARACTERS,
  ...HISTORICAL_BATCH66_CHARACTERS,
  ...HISTORICAL_BATCH67_CHARACTERS,
  ...HISTORICAL_BATCH68_CHARACTERS,
  ...HISTORICAL_BATCH69_CHARACTERS,
  ...HISTORICAL_BATCH70_CHARACTERS,
  ...HISTORICAL_BATCH71_CHARACTERS,
  ...HISTORICAL_BATCH72_CHARACTERS,
  ...HISTORICAL_BATCH73_CHARACTERS,
  ...HISTORICAL_BATCH74_CHARACTERS,
  ...HISTORICAL_BATCH75_CHARACTERS,
  ...HISTORICAL_BATCH76_CHARACTERS,
  ...HISTORICAL_BATCH77_CHARACTERS,
  ...HISTORICAL_BATCH78_CHARACTERS,
  ...HISTORICAL_BATCH79_CHARACTERS,
  ...HISTORICAL_BATCH80_CHARACTERS,
  ...HISTORICAL_BATCH81_CHARACTERS,
  ...HISTORICAL_BATCH82_CHARACTERS,
  ...HISTORICAL_BATCH83_CHARACTERS,
  ...HISTORICAL_BATCH84_CHARACTERS,
  ...HISTORICAL_BATCH85_CHARACTERS,
  ...HISTORICAL_BATCH86_CHARACTERS,
  ...HISTORICAL_BATCH87_CHARACTERS,
  ...HISTORICAL_BATCH88_CHARACTERS,
  ...HISTORICAL_BATCH89_CHARACTERS,
  ...HISTORICAL_BATCH90_CHARACTERS,
  ...FLASH_BATCH91_CHARACTERS,
  FENGJI_2026,
  ...ENTERTAINMENT_CHARACTERS,
] as const

const BY_ID = new Map(ALL_CHARACTERS.map((character) => [character.id, character]))
provideHuashenCharacterCatalog(ALL_CHARACTERS)
// 随机获得技能（神孙权【驭衡】）用的池子：技能连同它的归属一起登记
provideRandomSkillPool(ALL_CHARACTERS.flatMap((character) => character.skills
  .filter((skill) => !skill.granted)
  .map((skill) => ({
    id: skill.id,
    name: skill.name,
    characterId: character.id,
    characterName: character.name,
    kingdom: character.kingdom,
    maxHp: character.maxHp,
  }))))
// 随机抽武将牌（神典韦【挈挟】）用的池子，和化身共用同一份武将表
provideCharacterPool(ALL_CHARACTERS.map(({ id, name, pack, maxHp }) => ({ id, name, pack, maxHp })))

// 主公技要按势力找同伴，但势力表在这里才拼齐，所以运行时回注一个查询函数
provideKingdomLookup((characterId) => BY_ID.get(characterId)?.kingdom)
provideGeneralFactionLookup((characterId) => BY_ID.get(characterId)?.kingdom)
provideCharacterClanLookup((characterId) => BY_ID.get(characterId)?.clan)

export function getCharacter(characterId: string): CharacterDefinition | undefined {
  return BY_ID.get(characterId)
}

/**
 * 武将**开局自带**的技能 id。
 *
 * 标了 `granted` 的不算：那些是觉醒之后才授予的，开局就返回它们等于
 * 白送一个技能。运行中获得的技能由 `ownedSkillIds` 并上 `player.grantedSkills`。
 */
export function skillIdsOf(characterId: string): string[] {
  return BY_ID.get(characterId)?.skills.filter((skill) => !skill.granted).map((skill) => skill.id) ?? []
}

/**
 * 技能的中文显示名。
 *
 * 引擎里由公共机制代播的横幅（伤害来源改写、结算后获得牌）需要它——
 * 那些地方只拿得到 skillId，直接把 id 打进战报会出现「【huoshou】」这种文案。
 */
export function skillDisplayName(state: SanguoshaState, ownerId: PlayerId, skillId: string): string {
  const characterId = state.players.find((candidate) => candidate.id === ownerId)?.characterId
  const found = characterId ? BY_ID.get(characterId)?.skills.find((skill) => skill.id === skillId) : undefined
  return found?.name ?? ALL_CHARACTERS.flatMap((character) => character.skills).find((skill) => skill.id === skillId)?.name ?? skillId
}

provideSkillIdsLookup(skillIdsOf)

/**
 * 锁定技名单：说明里写了「锁定技」的就是，`locked` 字段可以显式覆盖。
 *
 * 从说明推断而不是另立一份名单，是为了不让两处失配——新武将只要按惯例
 * 把「锁定技」写进说明，【霆威】这类按锁定与否分流的效果就自动认得它。
 */
const LOCKED_SKILL_IDS = new Set(ALL_CHARACTERS
  .flatMap((character) => character.skills)
  .filter((skill) => skill.locked ?? skill.description.includes('锁定技'))
  .map((skill) => skill.id))

provideLockedSkillLookup((skillId) => LOCKED_SKILL_IDS.has(skillId))

/**
 * 一张武将牌被当作武器装备时，能借出哪些技能。
 *
 * 两道关：技能自己声明了 `qiexie`，**并且**不属于觉醒技 / 限定技 / 主公技
 * ——后三类由运行时的结构化标志判断，不看描述文字。
 * 全量清单见 `docs/qiexie-compatibility.md`。
 */
export function borrowableSkillIdsOf(characterId: string): string[] {
  const character = BY_ID.get(characterId)
  if (!character) return []
  return character.skills
    .filter((skill) => skill.qiexie === true)
    .filter((skill) => {
      const runtime = skillRuntimeOf(skill.id)
      return !runtime?.limited && !runtime?.awakening && !runtime?.lord
    })
    .map((skill) => skill.id)
}

provideBorrowableSkillLookup(borrowableSkillIdsOf)

export function allCharacterIds(): string[] {
  return ALL_CHARACTERS.map((character) => character.id)
}

/** Resolve a registered skill by its catalogued character and exact display name. */
export function skillIdByCharacterAndName(characterName: string, skillName: string): string | undefined {
  return ALL_CHARACTERS.find((character) => character.name === characterName)?.skills
    .find((skill) => skill.name === skillName && !skill.granted)?.id
}

export function entertainmentCharacterIds(): string[] {
  return ALL_CHARACTERS.filter((character) => character.pack === 'entertainment').map((character) => character.id)
}

export function isEntertainmentCharacter(characterId: string): boolean {
  return BY_ID.get(characterId)?.pack === 'entertainment'
}

const DUPLICATE_INDEX = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'] as const

/** 娱乐武将允许重复；同桌重复时给公开名称加座次编号，避免玩家看不出目标。 */
export function displayCharacterName(
  players: readonly { id: string; seat: number; characterId: string | null }[],
  playerId: string,
): string {
  const player = players.find((candidate) => candidate.id === playerId)
  const character = player?.characterId ? getCharacter(player.characterId) : undefined
  if (!player || !character) return '某角色'
  if (character.pack !== 'entertainment') return character.name
  const same = players
    .filter((candidate) => candidate.characterId === player.characterId)
    .sort((left, right) => left.seat - right.seat)
  if (same.length < 2) return character.name
  const index = same.findIndex((candidate) => candidate.id === playerId)
  return `${character.name}${DUPLICATE_INDEX[index] ?? `（${index + 1}）`}`
}

/**
 * 这名玩家使用锦囊时是否无视距离（奇才）。
 *
 * 读运行时的 `ignoresTrickDistance` 标志，**不写死技能 id**——
 * 以前这里是 `includes('qicai')`，等于把某个武将的技能名钉进了规则层，
 * 再来一个同类锁定技就必须改这一行。徐晃【断粮】那种「只加距离、不取消限制」
 * 的修正走另一个入口 `trickDistanceBonus`，两者互不干扰。
 */
export function ignoresTrickDistance(state: SanguoshaState, playerId: PlayerId, cardId?: CardId): boolean {
  return skillsOf(state, playerId, skillIdsOf).some((runtime) => (
    typeof runtime.ignoresTrickDistance === 'function'
      ? runtime.ignoresTrickDistance(state, playerId, cardId)
      : runtime.ignoresTrickDistance === true
  ))
}
