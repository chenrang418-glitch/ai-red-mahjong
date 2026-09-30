import type { CharacterDefinition } from './types'
import { drawCards } from '../../engine/draw'
import { effectiveCardColor, effectiveCardSuit, isCardUseProhibited, isTargetProhibited, registerSkillRuntime, type SkillHost, type ViewAsOption } from '../../engine/skills/runtime'
import { gainArmor, loseArmor } from '../../engine/armor'
import { flipCharacter } from '../../engine/character-state'
import { continueDyingAssists, resolveDamage } from '../../engine/damage'
import { canTarget, getAttackRange, getDistance } from '../../engine/distance'
import { handleEquipmentLost } from '../../engine/equipment'
import { loseHp, loseMaxHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { schedulePhaseSkipForPlayer } from '../../engine/turn'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseNumberRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseSuitRequest, ChooseTargetsRequest } from '../../engine/requests'
import { beginVirtualSlash, declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'
import { reshuffleDrawPile } from '../../engine/deck'
import { giveCards } from '../../engine/hand-transfer'
import { DAMAGE_TRICKS, DELAYED_TRICKS, INSTANT_TRICKS, instantTrickActions } from '../../engine/cards/tricks'
import { createVirtualTrick, virtualTrickChoices } from '../../engine/virtual-trick'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { getCharacter, skillIdsOf } from './standard'

const B51 = ':b51'
const skill = (id: string) => `${id}${B51}`

const MOU_CAOCAO: CharacterDefinition = {
  id: 'mou-caocao-b51', name: '谋·曹操', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: skill('jianxiong-mou-caocao'), name: '奸雄', description: '游戏开始时，你可以获得至多2枚“治世”标记。当你受到伤害后，你可以获得对你造成伤害的牌并摸2-X张牌（X为“治世”标记数），然后你可以移除1枚“治世”标记。' },
    { id: skill('qingzheng-mou-caocao'), name: '清正', description: '出牌阶段开始时，你可以弃置手牌中3-X种花色的所有牌（X为“治世”标记数），并观看一名有手牌的其他角色的手牌，弃置其中一种花色的所有牌；若其被弃置的牌数小于你弃置的牌数，你对其造成1点伤害。若你有“奸雄”且“治世”标记少于2枚，你可以获得1枚“治世”标记。' },
    { id: skill('hujia-mou-caocao'), name: '护驾', description: '主公技，每轮限一次，当你受到伤害时，你可以将此伤害转移给一名其他魏势力角色。' },
  ],
}

const MOU_CAOREN: CharacterDefinition = {
  id: 'mou-caoren-b51', name: '谋·曹仁', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: skill('jushou-mou-caoren'), name: '据守', description: '出牌阶段限一次，若你的武将牌正面朝上，你可以翻面并弃置至多两张牌，然后获得等量的护甲。当你背面朝上受到伤害后，你可以选择一项：1.获得1点护甲；2.翻至正面朝上，然后摸等同于你护甲值的牌。' },
    { id: skill('jiewei-mou-caoren'), name: '解围', description: '你可以失去1点护甲，然后观看一名其他角色的手牌并获得其中一张牌。' },
  ],
}

const MOU_ZHOUYU: CharacterDefinition = {
  id: 'mou-zhouyu-b51', name: '谋·周瑜', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('yingzi-mou-zhouyu'), name: '英姿', description: '锁定技，摸牌阶段，你以下的数值每满足一项，你多摸一张牌且本回合手牌上限+1：1.你的手牌数不少于2；2.你的体力值不低于2；3.你的装备区牌数不低于1。' },
    { id: skill('fanjian-mou-zhouyu'), name: '反间', description: '出牌阶段，你可以选择一名其他角色，扣置一张本回合未以此法扣置过花色的手牌，并声明一个花色。其选择猜测此牌花色与声明花色是否一致，或翻面。然后你展示此牌并令其获得之。若其选择猜测，猜对则此技能失效直到回合结束，猜错则其失去1点体力；若其选择翻面，此技能失效直到回合结束。' },
  ],
}

const MOU_ZHENJI: CharacterDefinition = {
  id: 'mou-zhenji-b51', name: '谋·甄姬', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('luoshen-mou-zhenji'), name: '洛神', description: '准备阶段，你可以选择一名角色，自其开始由不同的其他角色依次展示一张手牌（数量为存活人数的一半向上取整）；黑色牌由你获得且本回合不计入手牌上限，红色牌由展示者弃置。' },
    { id: skill('qingguo-mou-zhenji'), name: '倾国', description: '你可以将一张黑色手牌当【闪】使用或打出。' },
  ],
}

const JIE_WUYI: CharacterDefinition = {
  id: 'jie-wuyi-b51', name: '界·吴懿', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'wind',
  skills: [{ id: skill('benxi-jie-wuyi'), name: '奔袭', description: '出牌阶段开始时，你可以弃置任意张牌，然后本阶段计算与其他角色的距离-X（X为弃置牌数）。若如此做，本阶段你使用的下一张基本牌或普通锦囊牌可以额外指定至多X名距离为1的其他角色为目标；此牌结算结束后，若造成过伤害，你摸五张牌。' }],
}

const JIE_ZHUZHI: CharacterDefinition = {
  id: 'jie-zhuzhi-b51', name: '界·朱治', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [{ id: skill('anguo-jie-zhuzhi'), name: '安国', description: '游戏开始时，你令一名其他角色获得“安国”标记。其手牌上限等于体力上限。出牌阶段开始时，你可以将标记移至一名本局未获得过标记的其他角色。场上有标记时，若你受到的伤害不小于当前体力值且来源没有标记，你防止此伤害。标记角色进入濒死时，移除标记并令其回复至1点体力，然后你选择失去体力至1点或减体力上限至1点，最后其获得1点护甲。' }],
}

const MOU_DIAOCHAN: CharacterDefinition = {
  id: 'mou-diaochan-b51', name: '谋·貂蝉', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('lijian-mou-diaochan'), name: '离间', description: '出牌阶段限一次，你可以选择至少两名其他角色并弃置X张牌（X为选择角色数-1），然后这些角色依次对逆时针最近座次的另一名所选角色视为使用一张【决斗】。' },
    { id: skill('biyue-mou-diaochan'), name: '闭月', description: '锁定技，结束阶段，你摸X张牌（X为本回合受到伤害的角色数+1，至多为4）。' },
  ],
}

const MOU_PANGTONG: CharacterDefinition = {
  id: 'mou-pangtong-b51', name: '谋·庞统', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('yinmou-mou-pangtong'), name: '寅谋', description: '转换技，游戏开始时你可自选阴阳状态。每个回合结束时，若本回合有角色失去手牌数大于等于其剩余手牌数，你可以观看牌堆顶三张牌并交给一名角色一张；此牌离开其手牌区时，阳：其摸当前体力值张牌（至多5）；阴：其弃置当前体力值张牌。' },
    { id: skill('hongce-mou-pangtong'), name: '宏策', description: '首轮开始时，你令一名角色选择一项执行：1.将半数手牌（向上取整）置入弃牌堆并随机获得等量伤害牌，然后视为使用一张无次数限制的【杀】；2.重铸一张手牌，视为使用一张有合法单目标用法的普通锦囊牌；3.摸三张牌且这些牌不计入手牌上限。结算后，根据所选项修改“宏策”。修改后，出牌阶段限一次，你可令一名角色执行对应效果。' },
  ],
}

const MOU_LIUBEI: CharacterDefinition = {
  id: 'mou-liubei-b51', name: '谋·刘备', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: skill('rende-mou-liubei'), name: '仁德', description: '出牌阶段开始时，你获得2个“仁望”标记。出牌阶段，你可以将任意张牌交给一名本阶段未获得过“仁德”牌的其他角色，然后获得等量“仁望”（至多8个）。每回合限一次，当你需要使用或打出一张基本牌时，你可以弃置2个“仁望”视为使用或打出之。' },
    { id: skill('zhangwu-mou-liubei'), name: '章武', description: '限定技，出牌阶段，你可以令本局中所有获得过“仁德”牌的角色依次交给你Y张牌（Y为游戏轮数-1，至多3）。若如此做，你回复3点体力，然后失去“仁德”。' },
    { id: skill('jijiang-mou-liubei'), name: '激将', description: '主公技，出牌阶段结束时，你可指定一名角色，并令另一名攻击范围内含有该角色且体力值不小于你的其他蜀势力角色选择一项：1.视为对你指定的角色使用一张普通【杀】；2.跳过下一个出牌阶段。' },
  ],
}

const MOU_JIANGWEI: CharacterDefinition = {
  id: 'mou-jiangwei-b51', name: '谋·姜维', kingdom: 'shu', gender: 'male', maxHp: 4, initialArmor: 1, pack: 'sp',
  skills: [
    { id: skill('tiaoxin-mou-jiangwei'), name: '挑衅', description: '蓄力技，出牌阶段限一次，你可以至多选择X名其他角色（X为蓄力点数），令其依次选择：1.对你使用一张无距离限制的【杀】；2.交给你一张牌。然后每选择一名角色，减少1点蓄力点。弃牌阶段，你每弃置一张牌，获得1点蓄力点。' },
    { id: skill('zhiji-mou-jiangwei'), name: '志继', description: '觉醒技，准备阶段，若你发动“挑衅”选择过至少4名角色，你减1点体力上限，令任意名角色直到你的下个回合开始时获得“北伐”标记。拥有标记的角色使用牌只能选择你或其自身为目标。' },
  ],
}

type Batch51State = SanguoshaState & {
  b51ZhouyuHandLimit?: Record<PlayerId, { turn: number; amount: number }>
  b51DiaochanDamage?: { turn: number; playerIds: PlayerId[] }
  b51Luoshen?: Record<PlayerId, { order: PlayerId[]; index: number; exemptCardIds: CardId[] }>
  b51LuoshenExempt?: Record<PlayerId, { turn: number; cardIds: CardId[] }>
  b51Fanjian?: Record<PlayerId, { turn: number; usedSuits: string[]; disabled: boolean }>
  b51AnGuo?: Record<PlayerId, { targetId: PlayerId | null; everMarkedIds: PlayerId[] }>
  b51Lijian?: Record<PlayerId, { targetIds: PlayerId[]; index: number }>
  b51Wuyi?: Record<PlayerId, { turn: number; distanceReduction: number; pendingExtraTarget: boolean; watchedCardId: CardId | null; cardDealtDamage: boolean }>
  b51Tiaoxin?: Record<PlayerId, { targetIds: PlayerId[]; index: number }>
  b51Beifa?: Record<PlayerId, PlayerId[]>
  b51HujiaRound?: Record<PlayerId, number>
  b51HujiaBypass?: Record<PlayerId, string>
  b51Qingzheng?: Record<PlayerId, { targetId: PlayerId; costCount: number }>
  b51RendeRecipients?: Record<PlayerId, { turn: number; targetIds: PlayerId[] }>
  b51RendeRecipientsEver?: Record<PlayerId, PlayerId[]>
  b51PangtongMode?: Record<PlayerId, 'yin' | 'yang'>
  b51PangtongGifts?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId; mode: 'yin' | 'yang' }>
  b51Hongce?: Record<PlayerId, { mode: 1 | 2 | 3 | null; opened: boolean }>
  b51HongceExempt?: Record<CardId, PlayerId>
  b51HongcePending?: Record<PlayerId, { targetId: PlayerId; mode: 1 | 2 | 3; initial: boolean; virtualCardId?: CardId }>
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((player) => player.id === playerId)
}

function wuyiCardCategory(state: SanguoshaState, cardId: CardId, cardName: string): 'basic' | 'trick' | null {
  const card = state.cards[cardId]
  if (card?.category === 'basic') return 'basic'
  return card?.category === 'trick' && INSTANT_TRICKS.has(cardName) && !DELAYED_TRICKS.has(cardName) ? 'trick' : null
}

const CAOCAO_JIANXIONG = skill('jianxiong-mou-caocao')
const CAOCAO_QINGZHENG = skill('qingzheng-mou-caocao')
const CAOCAO_HUJIA = skill('hujia-mou-caocao')
const CAOCAO_ZHISHI = 'mouCaoCaoZhishi'
const PANGTONG_YINMOU = skill('yinmou-mou-pangtong')
const PANGTONG_MODE_YIN = 'b51PangtongModeYin'
const PANGTONG_MODE_YANG = 'b51PangtongModeYang'
const PANGTONG_HONGCE = skill('hongce-mou-pangtong')
const LIUBEI_RENDE = skill('rende-mou-liubei')
const LIUBEI_RENWANG = 'mouLiubeiRenwang'
const LIUBEI_ZHANGWU = skill('zhangwu-mou-liubei')
const LIUBEI_JIJIANG = skill('jijiang-mou-liubei')
const LIUBEI_BASIC_NAMES = ['杀', '闪', '桃', '酒'] as const
const LIUBEI_RENDE_USE = `${LIUBEI_RENDE}:basic-use`
const SUIT_LABEL: Record<string, string> = { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块' }
const hujiaDamageKey = (ownerId: PlayerId, context: { sourceId: PlayerId | null; amount: number; nature: string; cardId: CardId | null; cardName: string | null; chainTransfer: boolean }) =>
  JSON.stringify([ownerId, context.sourceId, context.amount, context.nature, context.cardId, context.cardName, context.chainTransfer])

function setPangtongMode(state: SanguoshaState, ownerId: PlayerId, mode: 'yin' | 'yang'): void {
  const owner = playerOf(state, ownerId)
  if (!owner) return
  ;((state as Batch51State).b51PangtongMode ??= {})[ownerId] = mode
  if (mode === 'yang') {
    owner.marks[PANGTONG_MODE_YANG] = 1
    delete owner.marks[PANGTONG_MODE_YIN]
  } else {
    owner.marks[PANGTONG_MODE_YIN] = 1
    delete owner.marks[PANGTONG_MODE_YANG]
  }
}

function isHongceDamageCard(state: SanguoshaState, cardId: CardId): boolean {
  const card = state.cards[cardId]
  return Boolean(card && (card.name.includes('杀') || DAMAGE_TRICKS.has(card.name) || card.name === '闪电'))
}

function hongceSlashTargets(state: SanguoshaState, sourceId: PlayerId): PlayerId[] {
  if (isCardUseProhibited(state, sourceId, '杀', { dyingPlayerId: null }, skillIdsOf)) return []
  return state.players.filter((target) => target.alive && canTarget(state, sourceId, target.id)
    && !isTargetProhibited(state, sourceId, target.id, '杀', skillIdsOf)).map((target) => target.id)
}

function setHongceMode(state: SanguoshaState, ownerId: PlayerId, mode: 1 | 2 | 3, initial: boolean): void {
  const current = ((state as Batch51State).b51Hongce ??= {})[ownerId] ?? { mode: null, opened: false }
  current.mode = mode
  if (initial) current.opened = true
  ;(state as Batch51State).b51Hongce![ownerId] = current
}

function askHongceTarget(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, mode: 1 | 2 | 3, initial: boolean): void {
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  const data = { targetId, mode, initial }
  if (mode === 1) {
    const count = Math.ceil(target.zones.hand.length / 2)
    if (!count) {
      const candidates = hongceSlashTargets(host.state, targetId)
      setHongceMode(host.state, ownerId, mode, initial)
      if (!candidates.length) return
      host.askSkill({ skillId: PANGTONG_HONGCE, ownerId, step: 'slash-target', data: { ...data, candidates },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: targetId,
          prompt: '【宏策】：选择视为使用无次数限制【杀】的目标', timeoutMs: 20_000, optional: false,
          candidateIds: candidates, min: 1, max: 1,
        }),
      })
      return
    }
    host.askSkill({ skillId: PANGTONG_HONGCE, ownerId, step: 'replace-half-hand', data: { ...data, count },
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetId,
        prompt: `【宏策】：选择${count}张手牌，以等量随机伤害牌替换`, timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: count, max: count,
      }),
    })
    return
  }
  if (mode === 2) {
    if (!target.zones.hand.length) { setHongceMode(host.state, ownerId, mode, initial); return }
    host.askSkill({ skillId: PANGTONG_HONGCE, ownerId, step: 'recast-for-trick', data,
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetId,
        prompt: '【宏策】：选择一张手牌重铸，然后视为使用单目标普通锦囊', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
    return
  }
  const drawn = drawCards(host.state, host.rng, targetId, 3, (name, payload) => { host.dispatch(name, payload) })
  const state = host.state as Batch51State
  state.b51HongceExempt ??= {}
  for (const cardId of drawn) state.b51HongceExempt[cardId] = targetId
  setHongceMode(host.state, ownerId, mode, initial)
}

registerSkillRuntime({
  id: PANGTONG_HONGCE,
  onGameStart(host, ownerId) {
    ;((host.state as Batch51State).b51Hongce ??= {})[ownerId] = { mode: null, opened: false }
  },
  handLimitExempt(state, ownerId, cardId) {
    const targetId = (state as Batch51State).b51HongceExempt?.[cardId]
    return Boolean(targetId && playerOf(state, targetId)?.zones.hand.includes(cardId)
      && playerOf(state, ownerId)?.alive)
  },
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const mode = (state as Batch51State).b51Hongce?.[ownerId]?.mode
    if (!owner?.alive || owner.characterId !== MOU_PANGTONG.id || state.phase !== 'play'
      || state.currentPlayerId !== ownerId || !mode || usedThisPhase(state, ownerId, PANGTONG_HONGCE)) return []
    const targets = state.players.filter((target) => target.alive && (mode !== 2
      || target.zones.hand.length > 0 && virtualTrickChoices(state, target.id, 1).length > 0))
    return targets.length ? [{ id: `skill:${PANGTONG_HONGCE}`, label: `宏策：令一名角色执行第${mode}项` }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${PANGTONG_HONGCE}` || usedThisPhase(host.state, ownerId, PANGTONG_HONGCE)) return
    const mode = (host.state as Batch51State).b51Hongce?.[ownerId]?.mode
    const candidates = host.state.players.filter((target) => target.alive && (mode !== 2
      || target.zones.hand.length > 0 && virtualTrickChoices(host.state, target.id, 1).length > 0)).map((target) => target.id)
    if (!mode || !candidates.length) return
    markUsedThisPhase(host.state, ownerId, PANGTONG_HONGCE)
    host.askSkill({ skillId: PANGTONG_HONGCE, ownerId, step: 'active-target', data: { mode },
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: `【宏策】：选择一名角色执行第${mode}项`, timeoutMs: 20_000, optional: false,
        candidateIds: candidates, min: 1, max: 1,
      }),
    })
  },
  triggers: [{ event: 'RoundStart', handle(host, ownerId) {
    const state = host.state as Batch51State
    const entry = state.b51Hongce?.[ownerId]
    if (host.state.roundNumber !== 1 || entry?.opened || !playerOf(host.state, ownerId)?.alive) return
    host.queueSkill({ skillId: PANGTONG_HONGCE, ownerId, step: 'initial-target', data: {} })
  } }, { event: 'HandCardLeft', handle(host, _ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; playerId?: PlayerId }
    const exempt = (host.state as Batch51State).b51HongceExempt
    if (!exempt || !payload.cardId) return
    if (exempt[payload.cardId] === payload.playerId) delete exempt[payload.cardId]
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'initial-target') return
    const candidates = host.state.players.filter((target) => target.alive).map((target) => target.id)
    if (!candidates.length) return
    host.askSkill({ skillId: PANGTONG_HONGCE, ownerId, step: 'choose-initial-target', data: {},
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【宏策】：选择一名角色令其执行一项', timeoutMs: 20_000, optional: false,
        candidateIds: candidates, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as Batch51State
    if (resolution.step === 'choose-initial-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      host.askSkill({ skillId: PANGTONG_HONGCE, ownerId, step: 'choose-initial-mode', data: { targetId },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: targetId,
          prompt: '【宏策】：选择执行一项并将其设为后续效果', timeoutMs: 20_000, optional: false,
          options: [
            { id: '1', label: '替换半数手牌为随机伤害牌并视为使用无次数限制的【杀】' },
            { id: '2', label: '重铸一张手牌并视为使用一张单目标普通锦囊' },
            { id: '3', label: '摸三张牌且这些牌不计入手牌上限' },
          ],
        }),
      })
      return
    }
    if (resolution.step === 'choose-initial-mode') {
      const mode = Number((response.payload as { optionId?: string }).optionId) as 1 | 2 | 3
      const targetId = resolution.data.targetId as PlayerId
      if (![1, 2, 3].includes(mode) || !playerOf(host.state, targetId)?.alive) return
      askHongceTarget(host, ownerId, targetId, mode, true)
      return
    }
    if (resolution.step === 'active-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const mode = resolution.data.mode as 1 | 2 | 3
      if (targetId && playerOf(host.state, targetId)?.alive) askHongceTarget(host, ownerId, targetId, mode, false)
      return
    }
    if (resolution.step === 'replace-half-hand') {
      const data = resolution.data as { targetId: PlayerId; mode: 1; initial: boolean; count: number }
      const target = playerOf(host.state, data.targetId)
      const chosen = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || chosen.length !== data.count || new Set(chosen).size !== chosen.length
        || chosen.some((cardId) => !target.zones.hand.includes(cardId))) return
      let available = host.state.zones.drawPile.filter((cardId) => isHongceDamageCard(host.state, cardId))
      if (available.length < chosen.length && host.state.zones.drawPile.length === 0)
        reshuffleDrawPile(host.state, host.rng, (name, payload) => { host.dispatch(name, payload) })
      available = host.state.zones.drawPile.filter((cardId) => isHongceDamageCard(host.state, cardId))
      const replacementIds = host.rng.shuffle(available).slice(0, chosen.length)
      if (replacementIds.length !== chosen.length) {
        setHongceMode(host.state, ownerId, data.mode, data.initial)
        return
      }
      for (const cardId of chosen) moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: target.id, cardIds: chosen, reason: PANGTONG_HONGCE }, { sourceId: ownerId, targetId: target.id, cardIds: chosen })
      for (const cardId of replacementIds) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
      if (replacementIds.length) host.dispatch('GainCard', { playerId: target.id, cardIds: replacementIds, reason: PANGTONG_HONGCE }, { sourceId: ownerId, targetId: target.id, cardIds: replacementIds })
      const candidates = hongceSlashTargets(host.state, target.id)
      setHongceMode(host.state, ownerId, data.mode, data.initial)
      if (!candidates.length) return
      host.askSkill({ skillId: PANGTONG_HONGCE, ownerId, step: 'slash-target', data: { targetId: target.id, candidates },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: target.id,
          prompt: '【宏策】：选择视为使用无次数限制【杀】的目标', timeoutMs: 20_000, optional: false,
          candidateIds: candidates, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'slash-target') {
      const sourceId = resolution.data.targetId as PlayerId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const candidates = resolution.data.candidates as PlayerId[]
      if (targetId && candidates.includes(targetId) && playerOf(host.state, sourceId)?.alive && playerOf(host.state, targetId)?.alive)
        beginVirtualSlash(host as never, { sourceId, targetId, sourceSkillId: PANGTONG_HONGCE, countUsage: false })
      return
    }
    if (resolution.step === 'recast-for-trick') {
      const data = resolution.data as { targetId: PlayerId; mode: 2; initial: boolean }
      const target = playerOf(host.state, data.targetId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: target.id, cardIds: [cardId], reason: 'recast' }, { sourceId: target.id, cardIds: [cardId] })
      drawCards(host.state, host.rng, target.id, 1, (name, payload) => { host.dispatch(name, payload) })
      const choices = virtualTrickChoices(host.state, target.id, 1)
      if (!choices.length) { setHongceMode(host.state, ownerId, data.mode, data.initial); return }
      host.askSkill({ skillId: PANGTONG_HONGCE, ownerId, step: 'choose-trick-name', data,
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: target.id,
          prompt: '【宏策】：选择一张有合法单目标用法的普通锦囊', timeoutMs: 20_000, optional: false,
          options: choices.map((name) => ({ id: name, label: name })),
        }),
      })
      return
    }
    if (resolution.step === 'choose-trick-name') {
      const data = resolution.data as { targetId: PlayerId; mode: 2; initial: boolean }
      const target = playerOf(host.state, data.targetId)
      const name = (response.payload as { optionId?: string }).optionId
      if (!target?.alive || !name || !virtualTrickChoices(host.state, target.id, 1).includes(name)) return
      const cardId = createVirtualTrick(host.state, target.id, name, PANGTONG_HONGCE)
      const actions = instantTrickActions(host.state, target.id, cardId, name)
        .filter((action) => action.kind === 'use-card' && action.targetIds.length === 1)
      if (!actions.length) { setHongceMode(host.state, ownerId, data.mode, data.initial); return }
      state.b51HongcePending ??= {}
      state.b51HongcePending[ownerId] = { targetId: target.id, mode: data.mode, initial: data.initial, virtualCardId: cardId }
      host.askSkill({ skillId: PANGTONG_HONGCE, ownerId, step: 'use-single-target-trick', data: { actionIds: actions.map((action) => action.id) },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: target.id,
          prompt: '【宏策】：选择此普通锦囊的合法目标与效果', timeoutMs: 20_000, optional: false,
          options: actions.map((action) => ({ id: action.id, label: action.label })),
        }),
      })
      return
    }
    if (resolution.step === 'use-single-target-trick') {
      const entry = state.b51HongcePending?.[ownerId]
      if (!entry?.virtualCardId) return
      const actionId = (response.payload as { optionId?: string }).optionId
      const action = instantTrickActions(host.state, entry.targetId, entry.virtualCardId)
        .find((candidate) => candidate.kind === 'use-card' && candidate.id === actionId && candidate.targetIds.length === 1)
      setHongceMode(host.state, ownerId, entry.mode, entry.initial)
      delete state.b51HongcePending?.[ownerId]
      if (action) executeUseCardAction(host as never, entry.targetId, action as never)
    }
  },
})

function askPangtongTopCard(host: SkillHost, ownerId: PlayerId): void {
  const cardIds: CardId[] = []
  while (cardIds.length < 3) {
    if (host.state.zones.drawPile.length === 0 && reshuffleDrawPile(host.state, host.rng, (name, payload) => { host.dispatch(name, payload) }) === 0) break
    const cardId = host.state.zones.drawPile[cardIds.length]
    if (!cardId) break
    cardIds.push(cardId)
  }
  if (!cardIds.length) return
  host.askSkill({ skillId: PANGTONG_YINMOU, ownerId, step: 'choose-top-card', data: { cardIds },
    build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
      prompt: '【寅谋】：观看牌堆顶牌并选择其中一张交给一名角色', timeoutMs: 20_000, optional: false,
      purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
    }),
  })
}

registerSkillRuntime({
  id: PANGTONG_YINMOU,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.queueSkill({ skillId: PANGTONG_YINMOU, ownerId, step: 'choose-mode', data: {} })
  },
  triggers: [
    { event: 'TurnEnd', handle(host, ownerId) {
      if (!playerOf(host.state, ownerId)?.alive) return
      const ledger = host.state.handCardLossThisTurn
      if (!ledger || ledger.turnNumber !== host.state.turnNumber) return
      const qualified = host.state.players.some((player) => (ledger.counts[player.id] ?? 0) >= player.zones.hand.length)
      if (qualified) host.queueSkill({ skillId: PANGTONG_YINMOU, ownerId, step: 'offer', data: {} })
    } },
    { event: 'HandCardLeft', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; playerId?: PlayerId }
      const gifts = (host.state as Batch51State).b51PangtongGifts
      const gift = payload.cardId ? gifts?.[payload.cardId] : undefined
      if (!gift || gift.ownerId !== ownerId || gift.targetId !== payload.playerId) return
      delete gifts![payload.cardId!]
      if (!playerOf(host.state, ownerId)?.alive) return
      host.queueSkill({ skillId: PANGTONG_YINMOU, ownerId, step: 'gift-left-hand', data: { targetId: gift.targetId, mode: gift.mode } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-mode') {
      host.askSkill({ skillId: PANGTONG_YINMOU, ownerId, step: 'choose-mode', data: {},
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: '【寅谋】：选择转换技的初始状态', timeoutMs: 20_000, optional: false,
          options: [{ id: 'yin', label: '阴：其牌离开手牌时弃置其当前体力值张手牌' }, { id: 'yang', label: '阳：其牌离开手牌时摸当前体力值张牌（至多5张）' }],
        }),
      })
      return
    }
    if (prompt.step === 'offer') {
      host.askSkill({ skillId: PANGTONG_YINMOU, ownerId, step: 'offer', data: {},
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: '【寅谋】：是否观看牌堆顶三张牌并交给一名角色一张？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'invoke', label: '发动【寅谋】' }, { id: 'decline', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step !== 'gift-left-hand') return
    const targetId = prompt.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    if (prompt.data.mode === 'yang') {
      const count = Math.min(5, Math.max(0, target.hp))
      if (count) drawCards(host.state, host.rng, target.id, count, (name, payload) => { host.dispatch(name, payload) })
      return
    }
    if (!target.zones.hand.length) return
    const count = Math.min(target.hp, target.zones.hand.length)
    if (count <= 0) return
    host.askSkill({ skillId: PANGTONG_YINMOU, ownerId, step: 'yin-discard', data: { targetId, count },
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetId,
        prompt: `【寅谋】：弃置${count}张手牌`, timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: count, max: count,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      if (mode === 'yin' || mode === 'yang') setPangtongMode(host.state, ownerId, mode)
      return
    }
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId === 'invoke') askPangtongTopCard(host, ownerId)
      return
    }
    if (resolution.step === 'choose-top-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const allowed = resolution.data.cardIds as CardId[]
      if (!cardId || !allowed.includes(cardId) || !host.state.zones.drawPile.includes(cardId)) return
      const candidateIds = host.state.players.filter((player) => player.alive).map((player) => player.id)
      host.askSkill({ skillId: PANGTONG_YINMOU, ownerId, step: 'choose-gift-recipient', data: { cardId },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【寅谋】：选择获得此牌的角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'choose-gift-recipient') {
      const cardId = resolution.data.cardId as CardId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || !host.state.zones.drawPile.includes(cardId)) return
      const state = host.state as Batch51State
      const mode = state.b51PangtongMode?.[ownerId] ?? 'yin'
      state.b51PangtongGifts ??= {}
      state.b51PangtongGifts[cardId] = { ownerId, targetId: target.id, mode }
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
      host.dispatch('GainCard', { playerId: target.id, cardIds: [cardId], reason: PANGTONG_YINMOU }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
      setPangtongMode(host.state, ownerId, mode === 'yin' ? 'yang' : 'yin')
      return
    }
    if (resolution.step === 'yin-discard') {
      const data = resolution.data as { targetId: PlayerId; count: number }
      const target = playerOf(host.state, data.targetId)
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || cardIds.length !== data.count || new Set(cardIds).size !== cardIds.length
        || cardIds.some((cardId) => !target.zones.hand.includes(cardId))) return
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: target.id, cardIds, reason: PANGTONG_YINMOU }, { sourceId: ownerId, targetId: target.id, cardIds })
    }
  },
})

registerSkillRuntime({
  id: LIUBEI_RENDE,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = playerOf(host.state, ownerId)
    if (event.playerId !== ownerId || event.phase !== 'play' || !owner?.alive) return
    owner.marks[LIUBEI_RENWANG] = Math.min(8, (owner.marks[LIUBEI_RENWANG] ?? 0) + 2)
    ;((host.state as Batch51State).b51RendeRecipients ??= {})[ownerId] = { turn: host.state.turnNumber, targetIds: [] }
  } }],
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const actions = []
    const basicUseAvailable = owner?.alive && owner.characterId === MOU_LIUBEI.id && state.phase === 'play'
      && state.currentPlayerId === ownerId && (owner.marks[LIUBEI_RENWANG] ?? 0) >= 2
      && !usedThisTurn(state, ownerId, LIUBEI_RENDE_USE)
    if (basicUseAvailable) actions.push({ id: `skill:${LIUBEI_RENDE_USE}`, label: '仁德：弃置2枚“仁望”，视为使用一张基本牌' })
    const ledger = (state as Batch51State).b51RendeRecipients?.[ownerId]
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId) return actions
    const usedTargets = ledger?.turn === state.turnNumber ? ledger.targetIds : []
    const targets = state.players.filter((target) => target.alive && target.id !== ownerId && !usedTargets.includes(target.id))
    if (targets.length && owner?.zones.hand.length) actions.push({ id: `skill:${LIUBEI_RENDE}`, label: '仁德：交给一名本阶段尚未获得过牌的角色任意张手牌' })
    return actions
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId === `skill:${LIUBEI_RENDE_USE}`) {
      const actions = liubeiRendeBasicUseActions(host.state, ownerId)
      if (!actions.length || (playerOf(host.state, ownerId)?.marks[LIUBEI_RENWANG] ?? 0) < 2
        || usedThisTurn(host.state, ownerId, LIUBEI_RENDE_USE)) return
      host.askSkill({ skillId: LIUBEI_RENDE, ownerId, step: 'choose-virtual-basic', data: { actions },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: '【仁德】：选择一项合法的基本牌用法（弃置2枚“仁望”）', timeoutMs: 20_000, optional: false,
          options: actions.map((action) => ({ id: action.id, label: action.label })),
        }),
      })
      return
    }
    if (actionId !== `skill:${LIUBEI_RENDE}`) return
    const owner = playerOf(host.state, ownerId)
    const ledger = (host.state as Batch51State).b51RendeRecipients?.[ownerId]
    const usedTargets = ledger?.turn === host.state.turnNumber ? ledger.targetIds : []
    const candidateIds = host.state.players.filter((target) => target.alive && target.id !== ownerId && !usedTargets.includes(target.id)).map((target) => target.id)
    if (!owner?.alive || !owner.zones.hand.length || !candidateIds.length) return
    host.askSkill({ skillId: LIUBEI_RENDE, ownerId, step: 'choose-recipient', data: {},
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【仁德】：选择一名本阶段未获得过“仁德”牌的其他角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-virtual-basic') {
      const chosenId = (response.payload as { optionId?: string }).optionId
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || (owner.marks[LIUBEI_RENWANG] ?? 0) < 2 || usedThisTurn(host.state, ownerId, LIUBEI_RENDE_USE)) return
      const action = liubeiRendeBasicUseActions(host.state, ownerId, chosenId).find((candidate) => candidate.id === chosenId)
      if (!action) return
      owner.marks[LIUBEI_RENWANG] -= 2
      if (owner.marks[LIUBEI_RENWANG] <= 0) delete owner.marks[LIUBEI_RENWANG]
      markUsedThisTurn(host.state, ownerId, LIUBEI_RENDE_USE)
      executeUseCardAction(host as never, ownerId, action as never)
      return
    }
    if (resolution.step === 'choose-recipient') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const ledger = (host.state as Batch51State).b51RendeRecipients?.[ownerId]
      const usedTargets = ledger?.turn === host.state.turnNumber ? ledger.targetIds : []
      if (!owner?.alive || !target?.alive || target.id === ownerId || usedTargets.includes(target.id) || !owner.zones.hand.length) return
      host.askSkill({ skillId: LIUBEI_RENDE, ownerId, step: 'give-cards', data: { targetId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: `【仁德】：选择交给${target.nickname}的任意张手牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: owner.zones.hand.length,
        }),
      })
      return
    }
    if (resolution.step !== 'give-cards') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !target?.alive || !cardIds.length || new Set(cardIds).size !== cardIds.length) return
    const given = giveCards(host as never, ownerId, targetId, cardIds, LIUBEI_RENDE)
    if (!given.length) return
    const state = host.state as Batch51State
    const ledger = state.b51RendeRecipients?.[ownerId]
    const recipients = ledger?.turn === host.state.turnNumber ? ledger : { turn: host.state.turnNumber, targetIds: [] }
    if (!recipients.targetIds.includes(targetId)) recipients.targetIds.push(targetId)
    ;(state.b51RendeRecipients ??= {})[ownerId] = recipients
    const ever = ((state.b51RendeRecipientsEver ??= {})[ownerId] ??= [])
    if (!ever.includes(targetId)) ever.push(targetId)
    owner.marks[LIUBEI_RENWANG] = Math.min(8, (owner.marks[LIUBEI_RENWANG] ?? 0) + given.length)
  },
  virtualBasicResponse(state, ownerId, requiredCardName) {
    const owner = playerOf(state, ownerId)
    return owner?.alive === true && owner.characterId === MOU_LIUBEI.id
      && (LIUBEI_BASIC_NAMES as readonly string[]).includes(requiredCardName)
      && (owner.marks[LIUBEI_RENWANG] ?? 0) >= 2 && !usedThisTurn(state, ownerId, LIUBEI_RENDE_USE)
  },
  consumeVirtualBasicResponse(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner || (owner.marks[LIUBEI_RENWANG] ?? 0) < 2 || usedThisTurn(host.state, ownerId, LIUBEI_RENDE_USE)) return
    owner.marks[LIUBEI_RENWANG] -= 2
    if (owner.marks[LIUBEI_RENWANG] <= 0) delete owner.marks[LIUBEI_RENWANG]
    markUsedThisTurn(host.state, ownerId, LIUBEI_RENDE_USE)
  },
  rescueActions(state, ownerId, dyingPlayerId) {
    const actions: Array<{ id: string; label: string }> = []
    if (this.virtualBasicResponse?.(state, ownerId, '桃')
      && !isCardUseProhibited(state, ownerId, '桃', { dyingPlayerId })) {
      actions.push({ id: `rescue-virtual-basic:${LIUBEI_RENDE}:桃`, label: '【仁德】：弃置2枚“仁望”视为使用【桃】' })
    }
    if (ownerId === dyingPlayerId && this.virtualBasicResponse?.(state, ownerId, '酒')
      && !isCardUseProhibited(state, ownerId, '酒', { dyingPlayerId })) {
      actions.push({ id: `rescue-virtual-basic:${LIUBEI_RENDE}:酒`, label: '【仁德】：弃置2枚“仁望”视为使用【酒】自救' })
    }
    return actions
  },
  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    const name = actionId.slice(`rescue-virtual-basic:${LIUBEI_RENDE}:`.length)
    if (!actionId.startsWith(`rescue-virtual-basic:${LIUBEI_RENDE}:`)
      || !['桃', '酒'].includes(name) || name === '酒' && ownerId !== dyingPlayerId
      || !this.virtualBasicResponse?.(host.state, ownerId, name)
      || isCardUseProhibited(host.state, ownerId, name, { dyingPlayerId })) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner) return false
    owner.marks[LIUBEI_RENWANG] -= 2
    if (owner.marks[LIUBEI_RENWANG] <= 0) delete owner.marks[LIUBEI_RENWANG]
    markUsedThisTurn(host.state, ownerId, LIUBEI_RENDE_USE)
    host.dispatch('CardResponded', { playerId: ownerId, cardId: null, cardName: name, virtual: true, reason: LIUBEI_RENDE },
      { sourceId: ownerId, targetId: dyingPlayerId })
    recover(host as never, dyingPlayerId, 1, ownerId)
    return true
  },
})

function liubeiRendeBasicUseActions(state: SanguoshaState, ownerId: PlayerId, retainActionId?: string) {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const options = ['杀', ...(owner.hp < owner.maxHp ? ['桃'] : []), '酒']
  const actions = []
  for (const name of options) {
    const cardId = `virtual:${LIUBEI_RENDE_USE}:${ownerId}:${state.turnNumber}:${name}`
    const existing = state.cards[cardId]
    if (existing) continue
    state.cards[cardId] = { id: cardId, ruleset: state.rulesetVersion, expansion: 'standard', name,
      suit: 'spade', rank: 1, color: 'black', category: 'basic', virtual: true, sourceSkillId: LIUBEI_RENDE }
    owner.zones.hand.push(cardId)
    const cardActions = declaredCardActions(state, ownerId, cardId, name, `视为使用【${name}】`)
    actions.push(...cardActions)
    if (!retainActionId || !cardActions.some((action) => action.id === retainActionId)) {
      owner.zones.hand.splice(owner.zones.hand.indexOf(cardId), 1)
      delete state.cards[cardId]
    }
  }
  return actions
}

function askNextZhangwuGiver(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[], index: number, amount: number): void {
  const owner = playerOf(host.state, ownerId)
  while (index < targetIds.length && !playerOf(host.state, targetIds[index])?.alive) index += 1
  if (!owner?.alive || index >= targetIds.length) {
    if (owner?.alive) {
      recover(host, ownerId, 3, ownerId)
      owner.permanentlyLostSkills ??= []
      if (!owner.permanentlyLostSkills.includes(LIUBEI_RENDE)) owner.permanentlyLostSkills.push(LIUBEI_RENDE)
    }
    return
  }
  const targetId = targetIds[index]
  const target = playerOf(host.state, targetId)!
  const count = Math.min(amount, target.zones.hand.length)
  if (count === 0) {
    askNextZhangwuGiver(host, ownerId, targetIds, index + 1, amount)
    return
  }
  host.askSkill({ skillId: LIUBEI_ZHANGWU, ownerId, step: 'give-zhangwu-cards', data: { targetIds, index, amount, targetId },
    build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetId,
      prompt: `【章武】：交给谋·刘备${count}张手牌`, timeoutMs: 20_000, optional: false,
      purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: count, max: count,
    }),
  })
}

registerSkillRuntime({
  id: LIUBEI_ZHANGWU,
  limited: true,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && owner.characterId === MOU_LIUBEI.id && state.phase === 'play'
      && state.currentPlayerId === ownerId && !owner.usedLimitedSkills.includes(LIUBEI_ZHANGWU)
      ? [{ id: `skill:${LIUBEI_ZHANGWU}`, label: '章武：令本局获得过仁德牌的角色依次交牌，然后回复体力并失去仁德' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    const owner = playerOf(host.state, ownerId)
    if (actionId !== `skill:${LIUBEI_ZHANGWU}` || !owner?.alive || owner.usedLimitedSkills.includes(LIUBEI_ZHANGWU)) return
    host.askSkill({ skillId: LIUBEI_ZHANGWU, ownerId, step: 'invoke-zhangwu', data: {},
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '【章武】：是否令本局获得过“仁德”牌的角色依次交牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'invoke', label: '发动限定技【章武】' }, { id: 'cancel', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke-zhangwu') {
      if ((response.payload as { optionId?: string }).optionId !== 'invoke') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.usedLimitedSkills.includes(LIUBEI_ZHANGWU)) return
      owner.usedLimitedSkills.push(LIUBEI_ZHANGWU)
      const ever = (host.state as Batch51State).b51RendeRecipientsEver?.[ownerId] ?? []
      const ordered = [...ever].sort((left, right) => {
        const leftSeat = playerOf(host.state, left)!.seat
        const rightSeat = playerOf(host.state, right)!.seat
        return (leftSeat - playerOf(host.state, ownerId)!.seat + host.state.players.length) % host.state.players.length
          - (rightSeat - playerOf(host.state, ownerId)!.seat + host.state.players.length) % host.state.players.length
      })
      const amount = Math.min(3, Math.max(0, host.state.roundNumber - 1))
      askNextZhangwuGiver(host, ownerId, ordered, 0, amount)
      return
    }
    if (resolution.step !== 'give-zhangwu-cards') return
    const data = resolution.data as { targetIds: PlayerId[]; index: number; amount: number; targetId: PlayerId }
    const target = playerOf(host.state, data.targetId)
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (target?.alive && new Set(cardIds).size === cardIds.length) giveCards(host as never, data.targetId, ownerId, cardIds, LIUBEI_ZHANGWU)
    askNextZhangwuGiver(host, ownerId, data.targetIds, data.index + 1, data.amount)
  },
})

function jijiangAttackers(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  const target = playerOf(state, targetId)
  if (!owner || !target?.alive) return []
  return state.players.filter((player) => player.alive && player.id !== ownerId && player.id !== targetId
    && getCharacter(player.characterId ?? '')?.kingdom === 'shu' && player.hp >= owner.hp
    && getDistance(state, player.id, targetId) <= getAttackRange(state, player.id)).map((player) => player.id)
}

registerSkillRuntime({
  id: LIUBEI_JIJIANG,
  lord: true,
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = playerOf(host.state, ownerId)
    if (phase.playerId === ownerId && phase.phase === 'play' && owner?.alive && owner.identity === 'lord')
      host.queueSkill({ skillId: LIUBEI_JIJIANG, ownerId, step: 'offer', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer' || playerOf(host.state, ownerId)?.identity !== 'lord') return
    const targets = host.state.players.filter((player) => player.alive).map((player) => player.id)
    if (!targets.length) return
    host.askSkill({ skillId: LIUBEI_JIJIANG, ownerId, step: 'choose-target', data: {},
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【激将】：选择一名角色，令符合条件的蜀势力角色响应', timeoutMs: 20_000, optional: false,
        candidateIds: targets, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      const candidates = jijiangAttackers(host.state, ownerId, targetId)
      if (!candidates.length) return
      host.askSkill({ skillId: LIUBEI_JIJIANG, ownerId, step: 'choose-attacker', data: { targetId },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【激将】：选择一名体力值不小于你的蜀势力角色', timeoutMs: 20_000, optional: false,
          candidateIds: candidates, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'choose-attacker') {
      const targetId = resolution.data.targetId as PlayerId
      const attackerId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!attackerId || !jijiangAttackers(host.state, ownerId, targetId).includes(attackerId)) return
      host.askSkill({ skillId: LIUBEI_JIJIANG, ownerId, step: 'attacker-choice', data: { targetId, attackerId },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: attackerId,
          prompt: '【激将】：选择视为对目标使用普通【杀】，或跳过你的下个出牌阶段', timeoutMs: 20_000, optional: false,
          options: [{ id: 'slash', label: '视为使用一张普通【杀】' }, { id: 'skip', label: '跳过下个出牌阶段' }],
        }),
      })
      return
    }
    if (resolution.step === 'attacker-choice') {
      const { targetId, attackerId } = resolution.data as { targetId: PlayerId; attackerId: PlayerId }
      if (!jijiangAttackers(host.state, ownerId, targetId).includes(attackerId)) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'slash') beginVirtualSlash(host as never, { sourceId: attackerId, targetId, sourceSkillId: LIUBEI_JIJIANG, countUsage: true })
      else if (optionId === 'skip') schedulePhaseSkipForPlayer(host.state, attackerId, 'play')
    }
  },
})

function askCaoCaoMarkNumber(host: SkillHost, ownerId: PlayerId): void {
  host.askSkill({ skillId: CAOCAO_JIANXIONG, ownerId, step: 'initial-marks', data: {},
    build: (id): ChooseNumberRequest => ({ id, kind: 'choose-number', playerId: ownerId,
      prompt: '【奸雄】：获得0至2枚“治世”标记', timeoutMs: 20_000, optional: false, min: 0, max: 2,
    }),
  })
}

registerSkillRuntime({
  id: CAOCAO_JIANXIONG,
  triggers: [
    { event: 'GameStart', handle(host, ownerId) {
      if (playerOf(host.state, ownerId)?.alive) host.queueSkill({ skillId: CAOCAO_JIANXIONG, ownerId, step: 'initial-marks', data: {} })
    } },
    { event: 'AfterDamage', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
      const payload = context.event.payload as { cardId?: CardId | null }
      host.queueSkill({ skillId: CAOCAO_JIANXIONG, ownerId, step: 'damage-choice', data: { cardId: payload.cardId ?? null } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'initial-marks') { askCaoCaoMarkNumber(host, ownerId); return }
    if (prompt.step !== 'damage-choice') return
    host.askSkill({ skillId: CAOCAO_JIANXIONG, ownerId, step: 'damage-choice', data: prompt.data,
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '【奸雄】：是否获得造成此伤害的牌并按“治世”标记摸牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'gain', label: '发动【奸雄】' }, { id: 'decline', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'initial-marks') {
      const number = (response.payload as { number?: number }).number
      if (!Number.isInteger(number) || number! < 0 || number! > 2) return
      owner.marks[CAOCAO_ZHISHI] = number!
      return
    }
    if (resolution.step === 'remove-mark') {
      if ((response.payload as { optionId?: string }).optionId === 'remove')
        owner.marks[CAOCAO_ZHISHI] = Math.max(0, (owner.marks[CAOCAO_ZHISHI] ?? 0) - 1)
      return
    }
    if (resolution.step !== 'damage-choice' || (response.payload as { optionId?: string }).optionId !== 'gain') return
    const cardId = resolution.data.cardId as CardId | null
    if (cardId && host.state.cards[cardId]) {
      const from = host.state.zones.processingArea.includes(cardId) ? { kind: 'processingArea' as const }
        : host.state.zones.discardPile.includes(cardId) ? { kind: 'discardPile' as const } : null
      if (from) {
        moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: CAOCAO_JIANXIONG }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
      }
    }
    const drawCount = Math.max(0, 2 - (owner.marks[CAOCAO_ZHISHI] ?? 0))
    if (drawCount) drawCards(host.state, host.rng, ownerId, drawCount, (name, payload) => { host.dispatch(name, payload) })
    if ((owner.marks[CAOCAO_ZHISHI] ?? 0) < 1) return
    host.askSkill({ skillId: CAOCAO_JIANXIONG, ownerId, step: 'remove-mark', data: {},
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '【奸雄】：是否移去一枚“治世”标记？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'remove', label: '移去一枚“治世”标记' }, { id: 'keep', label: '保留标记' }],
      }),
    })
  },
})

registerSkillRuntime({
  id: CAOCAO_QINGZHENG,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (event.playerId === ownerId && event.phase === 'play' && playerOf(host.state, ownerId)?.alive)
      host.queueSkill({ skillId: CAOCAO_QINGZHENG, ownerId, step: 'offer', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'offer') {
      const handSuits = new Set(owner.zones.hand.map((id) => effectiveCardSuit(host.state, ownerId, id)))
      const required = Math.max(1, 3 - (owner.marks[CAOCAO_ZHISHI] ?? 0))
      const targets = host.state.players.some((player) => player.alive && player.id !== ownerId && player.zones.hand.length)
      if (!targets || handSuits.size < required) return
      host.askSkill({ skillId: CAOCAO_QINGZHENG, ownerId, step: 'offer', data: {},
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: '【清正】：是否弃置指定花色的所有手牌，观看并弃置一名角色的手牌？', timeoutMs: 20_000,
          optional: true, options: [{ id: 'yes', label: '发动【清正】' }, { id: 'no', label: '不发动' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as Batch51State
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId && player.zones.hand.length).map((player) => player.id)
      if (!targets.length) return
      host.askSkill({ skillId: CAOCAO_QINGZHENG, ownerId, step: 'choose-target', data: {},
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【清正】：选择一名有手牌的其他角色', timeoutMs: 20_000, optional: false,
          candidateIds: targets, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const required = Math.max(1, 3 - (owner.marks[CAOCAO_ZHISHI] ?? 0))
      const suits = [...new Set(owner.zones.hand.map((id) => effectiveCardSuit(host.state, ownerId, id)))]
      if (!target?.alive || target.id === ownerId || !target.zones.hand.length || suits.length < required) return
      host.askSkill({ skillId: CAOCAO_QINGZHENG, ownerId, step: 'choose-suits', data: { targetId, required },
        build: (id): ChooseOptionsRequest => ({ id, kind: 'choose-options', playerId: ownerId,
          prompt: `【清正】：选择${required}种花色，弃置这些花色的所有手牌`, timeoutMs: 20_000, optional: false,
          options: suits.map((suit) => ({ id: suit, label: SUIT_LABEL[suit] ?? suit })), min: required, max: required,
        }),
      })
      return
    }
    if (resolution.step === 'choose-suits') {
      const targetId = resolution.data.targetId as PlayerId
      const required = Number(resolution.data.required)
      const chosen = (response.payload as { optionIds?: string[] }).optionIds ?? []
      const suitsInHand = new Set(owner.zones.hand.map((id) => effectiveCardSuit(host.state, ownerId, id)))
      if (chosen.length !== required || new Set(chosen).size !== chosen.length || chosen.some((suit) => !suitsInHand.has(suit as never))) return
      const costIds = owner.zones.hand.filter((id) => chosen.includes(effectiveCardSuit(host.state, ownerId, id)))
      if (!costIds.length) return
      markUsedThisPhase(host.state, ownerId, CAOCAO_QINGZHENG)
      for (const cardId of costIds) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      }
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: costIds, reason: CAOCAO_QINGZHENG }, { sourceId: ownerId, cardIds: costIds })
      const target = playerOf(host.state, targetId)
      if (!target?.alive || !target.zones.hand.length) return
      state.b51Qingzheng ??= {}
      state.b51Qingzheng[ownerId] = { targetId, costCount: costIds.length }
      const suits = [...new Set(target.zones.hand.map((id) => effectiveCardSuit(host.state, targetId, id)))]
      if (!suits.length) return
      host.askSkill({ skillId: CAOCAO_QINGZHENG, ownerId, step: 'choose-discard-suit', data: { targetId },
        build: (id): ChooseSuitRequest => ({ id, kind: 'choose-suit', playerId: ownerId,
          prompt: `【清正】：选择弃置${target.nickname}手牌中的一种花色`, timeoutMs: 20_000, optional: false, suits,
        }),
      })
      return
    }
    if (resolution.step === 'choose-discard-suit') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const chosenSuit = (response.payload as { suit?: string }).suit
      const entry = state.b51Qingzheng?.[ownerId]
      if (!target?.alive || !entry || entry.targetId !== targetId || !chosenSuit) return
      const discarded = target.zones.hand.filter((id) => effectiveCardSuit(host.state, targetId, id) === chosenSuit)
      if (discarded.length) {
        for (const cardId of discarded) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: discarded, reason: CAOCAO_QINGZHENG }, { sourceId: ownerId, targetId, cardIds: discarded })
      }
      delete state.b51Qingzheng?.[ownerId]
      if (discarded.length < entry.costCount) resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: '清正' })
      const current = owner.marks[CAOCAO_ZHISHI] ?? 0
      if (owner.alive && owner.characterId === MOU_CAOCAO.id && current < 2) {
        host.askSkill({ skillId: CAOCAO_QINGZHENG, ownerId, step: 'gain-mark', data: {},
          build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
            prompt: '【清正】：是否获得一枚“治世”标记？', timeoutMs: 20_000, optional: true,
            options: [{ id: 'gain', label: '获得一枚“治世”标记' }, { id: 'decline', label: '不获得' }],
          }),
        })
      }
      return
    }
    if (resolution.step === 'gain-mark' && (response.payload as { optionId?: string }).optionId === 'gain')
      owner.marks[CAOCAO_ZHISHI] = Math.min(2, (owner.marks[CAOCAO_ZHISHI] ?? 0) + 1)
  },
})

registerSkillRuntime({
  id: CAOCAO_HUJIA,
  lord: true,
  interceptIncomingDamage(host, ownerId, context) {
    const state = host.state as Batch51State
    const key = hujiaDamageKey(ownerId, context)
    if (state.b51HujiaBypass?.[ownerId] === key) {
      delete state.b51HujiaBypass[ownerId]
      return false
    }
    const owner = playerOf(host.state, ownerId)
    const spentRound = state.b51HujiaRound?.[ownerId]
    const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId
      && getCharacter(player.characterId ?? '')?.kingdom === 'wei').map((player) => player.id)
    if (!owner?.alive || owner.identity !== 'lord' || spentRound === host.state.roundNumber || !targets.length) return false
    host.askSkill({ skillId: CAOCAO_HUJIA, ownerId, step: 'offer-redirection', data: {
      sourceId: context.sourceId, amount: context.amount, nature: context.nature,
      cardId: context.cardId, cardName: context.cardName, chainTransfer: context.chainTransfer,
    }, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
      prompt: '【护驾】：是否将此伤害转移给一名魏势力角色？', timeoutMs: 20_000, optional: true,
      options: [{ id: 'redirect', label: '转移伤害' }, { id: 'take', label: '自己承受伤害' }],
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as Batch51State
    const data = resolution.data as { sourceId: PlayerId | null; amount: number; nature: 'normal' | 'fire' | 'thunder' | 'ice'; cardId: CardId | null; cardName: string | null; chainTransfer: boolean }
    if (resolution.step === 'offer-redirection') {
      const choose = (response.payload as { optionId?: string }).optionId
      if (choose !== 'redirect') {
        if (playerOf(host.state, ownerId)?.alive) {
          state.b51HujiaBypass ??= {}
          state.b51HujiaBypass[ownerId] = hujiaDamageKey(ownerId, data)
          resolveDamage(host as never, { ...data, targetId: ownerId })
        }
        return
      }
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId
        && getCharacter(player.characterId ?? '')?.kingdom === 'wei').map((player) => player.id)
      if (!candidates.length) {
        state.b51HujiaBypass ??= {}
        state.b51HujiaBypass[ownerId] = hujiaDamageKey(ownerId, data)
        resolveDamage(host as never, { ...data, targetId: ownerId })
        return
      }
      host.askSkill({ skillId: CAOCAO_HUJIA, ownerId, step: 'choose-recipient', data: resolution.data,
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【护驾】：选择承受此伤害的魏势力角色', timeoutMs: 20_000, optional: false,
          candidateIds: candidates, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step !== 'choose-recipient') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive || target.id === ownerId || getCharacter(target.characterId ?? '')?.kingdom !== 'wei') {
      if (owner?.alive) {
        state.b51HujiaBypass ??= {}
        state.b51HujiaBypass[ownerId] = hujiaDamageKey(ownerId, data)
        resolveDamage(host as never, { ...data, targetId: ownerId })
      }
      return
    }
    ;(state.b51HujiaRound ??= {})[ownerId] = host.state.roundNumber
    resolveDamage(host as never, { ...data, targetId: target.id, redirectedBy: CAOCAO_HUJIA })
    if (target.alive) drawCards(host.state, host.rng, target.id, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

// 【倾国】的实体牌筛选与普通甄姬共用规则，但使用独立技能 ID，避免借用其他角色的注册身份。
registerSkillRuntime({
  id: skill('luoshen-mou-zhenji'),
  handLimitExempt(state, ownerId, cardId) {
    const entry = (state as Batch51State).b51LuoshenExempt?.[ownerId]
    return entry?.turn === state.turnNumber && entry.cardIds.includes(cardId)
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (event.playerId === ownerId && event.phase === 'prepare' && playerOf(host.state, ownerId)?.alive)
      host.queueSkill({ skillId: skill('luoshen-mou-zhenji'), ownerId, step: 'choose-start', data: {} })
  } }, { event: 'TurnEnd', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId)
      delete (host.state as Batch51State).b51LuoshenExempt?.[ownerId]
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-start') {
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      if (!candidates.length) return
      host.askSkill({ skillId: skill('luoshen-mou-zhenji'), ownerId, step: 'start-target', data: {},
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【洛神】：选择展示手牌流程的起始角色', timeoutMs: 20_000, optional: true,
          candidateIds: candidates, min: 1, max: 1 }),
      })
      return
    }
    if (prompt.step !== 'show-hand') return
    const targetId = prompt.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    if (!target?.alive || !target.zones.hand.length) {
      advanceLuoshen(host.state, ownerId)
      askNextLuoshenCard(host, ownerId)
      return
    }
    host.askSkill({ skillId: skill('luoshen-mou-zhenji'), ownerId, step: 'show-hand', data: { targetId },
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetId,
        prompt: '【洛神】：选择一张手牌展示', timeoutMs: 20_000, optional: false, purpose: 'skill',
        cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1 }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'start-target') {
      const startId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const start = startId ? playerOf(host.state, startId) : undefined
      if (!start?.alive || start.id === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const count = Math.ceil(host.state.players.filter((player) => player.alive).length / 2)
      const order = host.state.players.filter((player) => player.alive && player.id !== ownerId)
        .sort((left, right) => ((left.seat - start.seat + host.state.players.length) % host.state.players.length)
          - ((right.seat - start.seat + host.state.players.length) % host.state.players.length))
        .slice(0, count).map((player) => player.id)
      ;((host.state as Batch51State).b51Luoshen ??= {})[ownerId] = { order, index: 0, exemptCardIds: [] }
      ;((host.state as Batch51State).b51LuoshenExempt ??= {})[ownerId] = { turn: host.state.turnNumber, cardIds: [] }
      askNextLuoshenCard(host, ownerId)
      return
    }
    if (resolution.step !== 'show-hand') return
    const state = host.state as Batch51State
    const entry = state.b51Luoshen?.[ownerId]
    const targetId = resolution.data.targetId as PlayerId
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const target = playerOf(host.state, targetId)
    const card = cardId ? host.state.cards[cardId] : undefined
    if (entry && target?.alive && cardId && card && target.zones.hand.includes(cardId)) {
      const black = effectiveCardColor(host.state, targetId, cardId) === 'black'
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, black
        ? { kind: 'hand', playerId: ownerId } : { kind: 'discardPile' })
      if (black) {
        entry.exemptCardIds.push(cardId)
        const exempt = state.b51LuoshenExempt?.[ownerId]
        if (exempt?.turn === host.state.turnNumber) exempt.cardIds.push(cardId)
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: skill('luoshen-mou-zhenji') },
          { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      } else host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: skill('luoshen-mou-zhenji') },
        { sourceId: ownerId, targetId, cardIds: [cardId] })
    }
    if (entry) entry.index += 1
    askNextLuoshenCard(host, ownerId)
  },
})

function advanceLuoshen(state: SanguoshaState, ownerId: PlayerId): void {
  const entry = (state as Batch51State).b51Luoshen?.[ownerId]
  if (entry) entry.index += 1
}

function askNextLuoshenCard(host: SkillHost, ownerId: PlayerId): void {
  const entry = (host.state as Batch51State).b51Luoshen?.[ownerId]
  if (!entry) return
  while (entry.index < entry.order.length) {
    const targetId = entry.order[entry.index]
    const target = playerOf(host.state, targetId)
    if (target?.alive && target.zones.hand.length) {
      host.queueSkill({ skillId: skill('luoshen-mou-zhenji'), ownerId, step: 'show-hand', data: { targetId } })
      return
    }
    entry.index += 1
  }
  delete (host.state as Batch51State).b51Luoshen![ownerId]
}

registerSkillRuntime({
  id: skill('qingguo-mou-zhenji'),
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    return owner.zones.hand.filter((cardId) => effectiveCardColor(state, ownerId, cardId) === 'black')
      .map((cardId) => ({ asCardName: '闪', cardId, label: `【倾国】：将【${state.cards[cardId]?.name ?? '牌'}】当【闪】使用或打出` }))
  },
})

registerSkillRuntime({
  id: skill('yingzi-mou-zhouyu'),
  maxCardsBonus(state, ownerId) {
    const bonus = (state as Batch51State).b51ZhouyuHandLimit?.[ownerId]
    return bonus?.turn === state.turnNumber ? bonus.amount : 0
  },
  triggers: [
    { event: 'DrawPhase', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; count?: number }
      const owner = playerOf(host.state, ownerId)
      if (payload.playerId !== ownerId || !owner?.alive) return
      const amount = Number(owner.zones.hand.length >= 2) + Number(owner.hp >= 2)
        + Number(Object.values(owner.zones.equipment).some(Boolean))
      payload.count = Math.max(0, Math.trunc(payload.count ?? 2)) + amount
      ;((host.state as Batch51State).b51ZhouyuHandLimit ??= {})[ownerId] = { turn: host.state.turnNumber, amount }
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (playerId === ownerId) delete (host.state as Batch51State).b51ZhouyuHandLimit?.[ownerId]
    } },
  ],
})

registerSkillRuntime({
  id: skill('fanjian-mou-zhouyu'),
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const current = (state as Batch51State).b51Fanjian?.[ownerId]
    const usedSuits = current?.turn === state.turnNumber ? current.usedSuits : []
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || current?.disabled) return []
    const eligible = owner.zones.hand.some((cardId) => !usedSuits.includes(effectiveCardSuit(state, ownerId, cardId)))
    return eligible && state.players.some((target) => target.alive && target.id !== ownerId)
      ? [{ id: `skill:${skill('fanjian-mou-zhouyu')}`, label: '反间：扣置一张未使用花色的手牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${skill('fanjian-mou-zhouyu')}`) return
    const owner = playerOf(host.state, ownerId)
    const current = (host.state as Batch51State).b51Fanjian?.[ownerId]
    const usedSuits = current?.turn === host.state.turnNumber ? current.usedSuits : []
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId || current?.disabled) return
    const cardIds = owner.zones.hand.filter((cardId) => !usedSuits.includes(effectiveCardSuit(host.state, ownerId, cardId)))
    const candidateIds = host.state.players.filter((target) => target.alive && target.id !== ownerId).map((target) => target.id)
    if (!cardIds.length || !candidateIds.length) return
    host.askSkill({ skillId: skill('fanjian-mou-zhouyu'), ownerId, step: 'select-card', data: {},
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【反间】：选择一张本回合未以此法扣置过花色的手牌',
        timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as Batch51State
    if (resolution.step === 'select-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = playerOf(host.state, ownerId)
      const current = state.b51Fanjian?.[ownerId]
      const usedSuits = current?.turn === host.state.turnNumber ? current.usedSuits : []
      if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      const suit = effectiveCardSuit(host.state, ownerId, cardId)
      if (usedSuits.includes(suit)) return
      const entry = current?.turn === host.state.turnNumber ? current : { turn: host.state.turnNumber, usedSuits: [], disabled: false }
      if (entry.disabled) return
      if (current?.turn !== host.state.turnNumber) state.b51Fanjian ??= {}, state.b51Fanjian[ownerId] = entry
      const candidateIds = host.state.players.filter((target) => target.alive && target.id !== ownerId).map((target) => target.id)
      if (!candidateIds.length) return
      host.askSkill({ skillId: skill('fanjian-mou-zhouyu'), ownerId, step: 'select-target', data: { cardId, suit },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【反间】：选择一名其他角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'select-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const cardId = resolution.data.cardId as CardId
      const owner = playerOf(host.state, ownerId)
      const current = state.b51Fanjian?.[ownerId]
      if (!owner?.alive || !target?.alive || target.id === ownerId || !owner.zones.hand.includes(cardId)
        || current?.turn === host.state.turnNumber && current.disabled) return
      const suit = effectiveCardSuit(host.state, ownerId, cardId)
      const usedSuits = current?.turn === host.state.turnNumber ? current.usedSuits : []
      if (usedSuits.includes(suit)) return
      const entry = current?.turn === host.state.turnNumber ? current : { turn: host.state.turnNumber, usedSuits: [], disabled: false }
      if (current?.turn !== host.state.turnNumber) state.b51Fanjian ??= {}, state.b51Fanjian[ownerId] = entry
      entry.usedSuits.push(suit)
      host.askSkill({ skillId: skill('fanjian-mou-zhouyu'), ownerId, step: 'declare-suit', data: { cardId, targetId, suit },
        build: (id) => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【反间】：声明一种花色',
          timeoutMs: 20_000, optional: false,
          options: ['spade', 'heart', 'club', 'diamond'].map((declared) => ({ id: declared, label: declared })),
        }),
      })
      return
    }
    if (resolution.step === 'declare-suit') {
      const declared = (response.payload as { optionId?: string }).optionId
      if (!['spade', 'heart', 'club', 'diamond'].includes(declared ?? '')) return
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const cardId = resolution.data.cardId as CardId
      if (!target?.alive || !playerOf(host.state, ownerId)?.zones.hand.includes(cardId)) return
      host.askSkill({ skillId: skill('fanjian-mou-zhouyu'), ownerId, step: 'target-choice', data: { ...resolution.data, declared },
        build: (id) => ({ id, kind: 'choose-option', playerId: targetId, prompt: '【反间】：猜测扣置牌与声明花色是否一致，或翻面',
          timeoutMs: 20_000, optional: false,
          options: [
            { id: 'match', label: '猜一致' },
            { id: 'different', label: '猜不一致' },
            { id: 'flip', label: '翻面' },
          ],
        }),
      })
      return
    }
    if (resolution.step !== 'target-choice') return
    const cardId = resolution.data.cardId as CardId
    const targetId = resolution.data.targetId as PlayerId
    const declared = resolution.data.declared as string
    const choice = (response.payload as { optionId?: string }).optionId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    const entry = state.b51Fanjian?.[ownerId]
    if (!owner?.alive || !target?.alive || !owner.zones.hand.includes(cardId)
      || !['match', 'different', 'flip'].includes(choice ?? '')) return
    const actualSuit = effectiveCardSuit(host.state, ownerId, cardId)
    const match = actualSuit === declared
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: skill('fanjian-mou-zhouyu') },
      { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: skill('fanjian-mou-zhouyu') },
      { sourceId: ownerId, targetId, cardIds: [cardId] })
    if (choice === 'flip') {
      flipCharacter(host, targetId, skill('fanjian-mou-zhouyu'))
      if (entry?.turn === host.state.turnNumber) entry.disabled = true
    } else if ((choice === 'match') === match) {
      if (entry?.turn === host.state.turnNumber) entry.disabled = true
    } else loseHp(host, targetId, 1, skill('fanjian-mou-zhouyu'))
  },
})

registerSkillRuntime({
  id: skill('anguo-jie-zhuzhi'),
  globalMaxCardsBonus(state, ownerId, targetId) {
    const ownerState = (state as Batch51State).b51AnGuo?.[ownerId]
    const target = playerOf(state, targetId)
    if (!target?.alive || ownerState?.targetId !== targetId || !target.marks.anGuo) return 0
    return Math.max(0, target.maxHp - target.hp)
  },
  preventsDamage(state, ownerId, side, context) {
    if (side !== 'target' || context.targetId !== ownerId) return false
    const sourceMarked = Boolean(context.sourceId && playerOf(state, context.sourceId)?.marks.anGuo)
    const markerExists = state.players.some((player) => player.alive && player.marks.anGuo)
    const owner = playerOf(state, ownerId)
    return Boolean(owner?.alive && markerExists && !sourceMarked && context.amount >= owner.hp)
  },
  triggers: [
    { event: 'GameStart', handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (owner?.alive && host.state.players.some((player) => player.alive && player.id !== ownerId))
        host.queueSkill({ skillId: skill('anguo-jie-zhuzhi'), ownerId, step: 'choose-initial-target', data: {} })
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      const entry = (host.state as Batch51State).b51AnGuo?.[ownerId]
      if (event.playerId !== ownerId || event.phase !== 'play' || !entry?.targetId || !playerOf(host.state, ownerId)?.alive) return
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId
        && !entry.everMarkedIds.includes(player.id))
      if (candidates.length) host.queueSkill({ skillId: skill('anguo-jie-zhuzhi'), ownerId, step: 'move-marker', data: {} })
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const deadId = context.event.targetId
      const entry = (host.state as Batch51State).b51AnGuo?.[ownerId]
      if (!entry || entry.targetId !== deadId) return
      const marked = deadId ? playerOf(host.state, deadId) : undefined
      if (marked) delete marked.marks.anGuo
      entry.targetId = null
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const entry = (host.state as Batch51State).b51AnGuo?.[ownerId]
    if (prompt.step === 'choose-initial-target') {
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      if (!candidates.length) return
      host.askSkill({ skillId: skill('anguo-jie-zhuzhi'), ownerId, step: prompt.step, data: {},
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【安国】：选择一名其他角色获得“安国”标记', timeoutMs: 20_000, optional: false,
          candidateIds: candidates, min: 1, max: 1,
        }),
      })
      return
    }
    if (prompt.step !== 'move-marker' || !entry?.targetId) return
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId
      && !entry.everMarkedIds.includes(player.id)).map((player) => player.id)
    if (!candidates.length) return
    host.askSkill({ skillId: skill('anguo-jie-zhuzhi'), ownerId, step: prompt.step, data: {},
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【安国】：可将标记移至本局未获得过标记的一名其他角色', timeoutMs: 20_000,
        optional: true, candidateIds: candidates, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as Batch51State
    const entry = state.b51AnGuo?.[ownerId]
    if (resolution.step === 'choose-initial-target' || resolution.step === 'move-marker') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const owner = playerOf(host.state, ownerId)
      if (!targetId || !target?.alive || !owner?.alive || target.id === ownerId) return
      const isInitial = resolution.step === 'choose-initial-target'
      const current = entry ?? { targetId: null, everMarkedIds: [] }
      if (!isInitial && (!current.targetId || current.everMarkedIds.includes(targetId))) return
      if (current.targetId) {
        const previous = playerOf(host.state, current.targetId)
        if (previous) delete previous.marks.anGuo
      }
      if (!current.everMarkedIds.includes(targetId)) current.everMarkedIds.push(targetId)
      current.targetId = targetId
      target.marks.anGuo = 1
      ;(state.b51AnGuo ??= {})[ownerId] = current
      return
    }
    if (resolution.step !== 'dying-choice') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    const dying = host.state.dying
    const choice = (response.payload as { optionId?: string }).optionId
    if (!target?.alive || !owner?.alive || dying?.playerId !== targetId || target.hp > 0
      || !['lose-hp', 'lose-max-hp', 'no-cost'].includes(choice ?? '')) return
    const canLoseHp = owner.hp > 1
    const canLoseMaxHp = owner.maxHp > 1
    if ((choice === 'lose-hp' && !canLoseHp) || (choice === 'lose-max-hp' && !canLoseMaxHp)
      || (choice === 'no-cost' && (canLoseHp || canLoseMaxHp))) return
    const recovered = 1 - target.hp
    target.hp = 1
    host.dispatch('Recover', { playerId: targetId, amount: recovered, reason: skill('anguo-jie-zhuzhi') },
      { sourceId: ownerId, targetId })
    if (choice === 'lose-hp') loseHp(host, ownerId, owner.hp - 1, skill('anguo-jie-zhuzhi'))
    else if (choice === 'lose-max-hp') loseMaxHp(host, ownerId, owner.maxHp - 1, skill('anguo-jie-zhuzhi'))
    gainArmor(host, targetId, 1, skill('anguo-jie-zhuzhi'))
    continueDyingAssists(host as never)
  },
  dyingAssist(host, ownerId, dyingPlayerId) {
    const entry = (host.state as Batch51State).b51AnGuo?.[ownerId]
    const target = playerOf(host.state, dyingPlayerId)
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive || entry?.targetId !== dyingPlayerId || !target.marks.anGuo
      || host.state.dying?.playerId !== dyingPlayerId) return false
    delete target.marks.anGuo
    entry.targetId = null
    const options = [
      ...(owner.hp > 1 ? [{ id: 'lose-hp', label: '失去体力至1点' }] : []),
      ...(owner.maxHp > 1 ? [{ id: 'lose-max-hp', label: '减体力上限至1点' }] : []),
      { id: 'no-cost', label: '无法支付代价' },
    ]
    host.askSkill({ skillId: skill('anguo-jie-zhuzhi'), ownerId, step: 'dying-choice', data: { targetId: dyingPlayerId },
      build: (id) => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【安国】：选择代价，令其回复至1点体力',
        timeoutMs: 20_000, optional: false, options,
      }),
    })
    return 'pending'
  },
})

registerSkillRuntime({
  id: skill('jushou-mou-caoren'),
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.faceDown || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, skill('jushou-mou-caoren'))) return []
    return [{ id: `skill:${skill('jushou-mou-caoren')}`, label: '据守：翻面并弃置至多两张牌获得护甲' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${skill('jushou-mou-caoren')}`) return
    const owner = playerOf(host.state, ownerId)
    const cardIds = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
    if (!owner?.alive || owner.faceDown || usedThisPhase(host.state, ownerId, skill('jushou-mou-caoren'))) return
    host.askSkill({ skillId: skill('jushou-mou-caoren'), ownerId, step: 'discard-for-armor', data: {},
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【据守】：选择弃置一至两张手牌或装备牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: Math.min(2, cardIds.length) }),
    })
  },
  triggers: [{ event: 'AfterDamage', handle(host, ownerId, context) {
    const owner = playerOf(host.state, ownerId)
    if (context.event.targetId === ownerId && owner?.alive && owner.faceDown)
      host.queueSkill({ skillId: skill('jushou-mou-caoren'), ownerId, step: 'damage-option', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'damage-option') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !owner.faceDown) return
    host.askSkill({ skillId: skill('jushou-mou-caoren'), ownerId, step: 'damage-option', data: {},
      build: (id) => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【据守】：是否发动并选择一项', timeoutMs: 20_000, optional: true,
        options: [
          { id: 'armor', label: '获得1点护甲' },
          { id: 'flip', label: '翻至正面并摸等同当前护甲值的牌' },
        ] }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard-for-armor') {
      const owner = playerOf(host.state, ownerId)
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = selected.length <= 2 && selected.every((cardId) =>
        owner?.zones.hand.includes(cardId) || Object.values(owner?.zones.equipment ?? {}).includes(cardId))
      if (!owner?.alive || owner.faceDown || !valid || usedThisPhase(host.state, ownerId, skill('jushou-mou-caoren'))) return
      markUsedThisPhase(host.state, ownerId, skill('jushou-mou-caoren'))
      for (const cardId of selected) {
        const from = owner.zones.hand.includes(cardId) ? { kind: 'hand' as const, playerId: ownerId }
          : { kind: 'equipment' as const, playerId: ownerId, slot: Object.entries(owner.zones.equipment).find(([, id]) => id === cardId)![0] as keyof typeof owner.zones.equipment }
        moveCard(host.state, cardId, from, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: skill('jushou-mou-caoren') }, { sourceId: ownerId, cardIds: [cardId] })
      }
      flipCharacter(host, ownerId, skill('jushou-mou-caoren'), true)
      gainArmor(host, ownerId, selected.length, skill('jushou-mou-caoren'))
      return
    }
    if (resolution.step === 'damage-option') {
      const owner = playerOf(host.state, ownerId)
      const option = (response.payload as { optionId?: string }).optionId
      if (!owner?.alive || !owner.faceDown) return
      if (option === 'armor') gainArmor(host, ownerId, 1, skill('jushou-mou-caoren'))
      else if (option === 'flip') {
        const armor = Math.max(0, owner.armorPoints ?? 0)
        flipCharacter(host, ownerId, skill('jushou-mou-caoren'), false)
        if (armor) drawCards(host.state, host.rng, ownerId, armor, (name, payload) => { host.dispatch(name, payload) })
      }
      return
    }
  },
})

registerSkillRuntime({
  id: skill('jiewei-mou-caoren'),
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId && (owner.armorPoints ?? 0) > 0
      && state.players.some((target) => target.alive && target.id !== ownerId && target.zones.hand.length)
      ? [{ id: `skill:${skill('jiewei-mou-caoren')}`, label: '解围：失去1点护甲并获得一名角色的一张手牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${skill('jiewei-mou-caoren')}` || (playerOf(host.state, ownerId)?.armorPoints ?? 0) < 1) return
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId && target.zones.hand.length).map((target) => target.id)
    if (!candidates.length) return
    host.askSkill({ skillId: skill('jiewei-mou-caoren'), ownerId, step: 'choose-target', data: {},
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【解围】：选择一名有手牌的其他角色', timeoutMs: 20_000, optional: false,
        candidateIds: candidates, min: 1, max: 1 }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-target') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || (owner.armorPoints ?? 0) < 1) return
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.id === ownerId || !target.zones.hand.length) return
      if (loseArmor(host, ownerId, 1, skill('jiewei-mou-caoren')) !== 1) return
      host.askSkill({ skillId: skill('jiewei-mou-caoren'), ownerId, step: 'take-hand-card', data: { targetId, armorPaid: true },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: `【解围】：观看并获得${target.nickname}的一张手牌`, timeoutMs: 20_000,
          optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1 }),
      })
      return
    }
    if (resolution.step !== 'take-hand-card') return
    const owner = playerOf(host.state, ownerId)
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!owner?.alive || !target?.alive || resolution.data.armorPaid !== true || !cardId || !target.zones.hand.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: skill('jiewei-mou-caoren') }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: skill('jiewei-mou-caoren') }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
  },
})

registerSkillRuntime({
  id: skill('biyue-mou-diaochan'),
  triggers: [
    { event: 'TurnStart', handle(host) {
      ;(host.state as Batch51State).b51DiaochanDamage = { turn: host.state.turnNumber, playerIds: [] }
    } },
    { event: 'DamageSettled', handle(host, _ownerId, context) {
      const amount = Math.max(0, Math.trunc(Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)))
      if (!amount || !context.event.targetId) return
      const state = host.state as Batch51State
      if (state.b51DiaochanDamage?.turn !== host.state.turnNumber)
        state.b51DiaochanDamage = { turn: host.state.turnNumber, playerIds: [] }
      const players = state.b51DiaochanDamage!.playerIds
      if (!players.includes(context.event.targetId)) players.push(context.event.targetId)
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (event.playerId !== ownerId || event.phase !== 'finish' || !playerOf(host.state, ownerId)?.alive) return
      const entry = (host.state as Batch51State).b51DiaochanDamage
      const count = Math.min(4, 1 + (entry?.turn === host.state.turnNumber ? entry.playerIds.length : 0))
      drawCards(host.state, host.rng, ownerId, count, (name, payload) => { host.dispatch(name, payload) })
    } },
  ],
})

registerSkillRuntime({
  id: skill('benxi-jie-wuyi'),
  distanceModifier: {
    toOthers(state, ownerId) {
      const entry = (state as Batch51State).b51Wuyi?.[ownerId]
      return entry?.turn === state.turnNumber && state.phase === 'play' && state.currentPlayerId === ownerId
        ? -entry.distanceReduction : 0
    },
  },
  modifiesNextCardTargets(state, ownerId, cardId, cardName) {
    const entry = (state as Batch51State).b51Wuyi?.[ownerId]
    return Boolean(entry?.turn === state.turnNumber && entry.pendingExtraTarget
      && state.phase === 'play' && state.currentPlayerId === ownerId && wuyiCardCategory(state, cardId, cardName))
  },
  nextCardTargetExpansion(state, ownerId, cardId, cardName) {
    const entry = (state as Batch51State).b51Wuyi?.[ownerId]
    if (entry?.turn !== state.turnNumber || !entry.pendingExtraTarget
      || !wuyiCardCategory(state, cardId, cardName)) return null
    return {
      maxAdditionalTargets: entry.distanceReduction,
      candidateIds: state.players.filter((target) => target.alive && target.id !== ownerId
        && getDistance(state, ownerId, target.id) === 1).map((target) => target.id),
    }
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = playerOf(host.state, ownerId)
      const discardable = owner && [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      if (event.playerId === ownerId && event.phase === 'play' && owner?.alive && discardable?.length)
        host.queueSkill({ skillId: skill('benxi-jie-wuyi'), ownerId, step: 'discard-for-range', data: {} })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const entry = (host.state as Batch51State).b51Wuyi?.[ownerId]
      const cardId = payload.cardId
      if (context.event.sourceId !== ownerId || !cardId || entry?.turn !== host.state.turnNumber
        || !entry.pendingExtraTarget || !wuyiCardCategory(host.state, cardId, payload.cardName ?? '')) return
      entry.pendingExtraTarget = false
      entry.watchedCardId = cardId
      entry.cardDealtDamage = false
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId | null; finalAmount?: number }
      const entry = (host.state as Batch51State).b51Wuyi?.[ownerId]
      if (entry && entry.watchedCardId !== null && entry.watchedCardId === payload.cardId && Number(payload.finalAmount ?? 0) > 0)
        entry.cardDealtDamage = true
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      const entry = (host.state as Batch51State).b51Wuyi?.[ownerId]
      if (context.event.sourceId !== ownerId || !entry || entry.watchedCardId !== payload.cardId) return
      const drawFive = entry.cardDealtDamage
      entry.watchedCardId = null
      entry.cardDealtDamage = false
      if (drawFive && playerOf(host.state, ownerId)?.alive)
        drawCards(host.state, host.rng, ownerId, 5, (name, data) => { host.dispatch(name, data) })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (event.playerId === ownerId && event.phase === 'play') delete (host.state as Batch51State).b51Wuyi?.[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard-for-range') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
    const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    if (!cardIds.length) return
    host.askSkill({ skillId: skill('benxi-jie-wuyi'), ownerId, step: prompt.step, data: {},
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【奔袭】：弃置任意张手牌或装备牌，本阶段距离减少等同张数', timeoutMs: 20_000,
        optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: cardIds.length,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard-for-range') return
    const owner = playerOf(host.state, ownerId)
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const uniqueCardIds = new Set(cardIds)
    const sources = cardIds.map((cardId) => ({ cardId, from: locateOwnedCard(host.state, ownerId, cardId) }))
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || !cardIds.length || uniqueCardIds.size !== cardIds.length
      || sources.some(({ from }) => !from || from.kind === 'judgingArea' || from.kind === 'characterPile')) return
    for (const { cardId, from } of sources) {
      if (!from) continue
      moveCard(host.state, cardId, from, { kind: 'discardPile' })
      if (from.kind === 'equipment') handleEquipmentLost(host as never, ownerId, cardId)
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: skill('benxi-jie-wuyi') },
        { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
    }
    ;((host.state as Batch51State).b51Wuyi ??= {})[ownerId] = {
      turn: host.state.turnNumber, distanceReduction: cardIds.length, pendingExtraTarget: true,
      watchedCardId: null, cardDealtDamage: false,
    }
  },
})

registerSkillRuntime({
  id: skill('lijian-mou-diaochan'),
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const candidates = state.players.filter((player) => player.alive && player.id !== ownerId)
    const discardable = owner && [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId
      && !usedThisPhase(state, ownerId, skill('lijian-mou-diaochan')) && candidates.length >= 2
      && (discardable?.length ?? 0) >= 1
      ? [{ id: `skill:${skill('lijian-mou-diaochan')}`, label: '离间：选择至少两名角色并弃牌，依次视为使用【决斗】' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${skill('lijian-mou-diaochan')}` || usedThisPhase(host.state, ownerId, skill('lijian-mou-diaochan'))) return
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
    if (candidates.length < 2) return
    host.askSkill({ skillId: skill('lijian-mou-diaochan'), ownerId, step: 'choose-duel-targets', data: {},
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【离间】：选择至少两名其他角色', timeoutMs: 20_000, optional: false,
        candidateIds: candidates, min: 2, max: candidates.length,
      }),
    })
  },
  triggers: [{ event: 'AfterCardUse', allowDeadOwner: true, handle(host, ownerId, context) {
    const payload = context.event.payload as { sourceSkillId?: string }
    const entry = (host.state as Batch51State).b51Lijian?.[ownerId]
    if (payload.sourceSkillId !== skill('lijian-mou-diaochan') || !entry) return
    entry.index += 1
    host.queueSkill({ skillId: skill('lijian-mou-diaochan'), ownerId, step: 'next-duel', data: {}, allowDeadOwner: true })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'next-duel') return
    const state = host.state as Batch51State
    const entry = state.b51Lijian?.[ownerId]
    if (!entry) return
    while (entry.index < entry.targetIds.length) {
      const sourceId = entry.targetIds[entry.index]
      const source = playerOf(host.state, sourceId)
      const aliveOthers = entry.targetIds.filter((id) => id !== sourceId && playerOf(host.state, id)?.alive)
      if (!source?.alive || !aliveOthers.length) { entry.index += 1; continue }
      const seatCount = host.state.players.length
      const targetId = aliveOthers.map((id) => playerOf(host.state, id)!)
        .sort((left, right) => ((source.seat - left.seat + seatCount) % seatCount)
          - ((source.seat - right.seat + seatCount) % seatCount))[0].id
      if (host.beginVirtualTrick({ sourceId, targetId, cardName: '决斗', sourceSkillId: skill('lijian-mou-diaochan') })) return
      entry.index += 1
    }
    delete state.b51Lijian?.[ownerId]
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-duel-targets') {
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || targetIds.length < 2 || new Set(targetIds).size !== targetIds.length
        || targetIds.some((id) => id === ownerId || !playerOf(host.state, id)?.alive)) return
      const targetSet = new Set(targetIds)
      const legalIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      const discardCount = targetIds.length - 1
      if (legalIds.length < discardCount) return
      markUsedThisPhase(host.state, ownerId, skill('lijian-mou-diaochan'))
      host.askSkill({ skillId: skill('lijian-mou-diaochan'), ownerId, step: 'discard-cost', data: { targetIds: [...targetSet] },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: `【离间】：弃置${discardCount}张手牌或装备牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: legalIds, hiddenCardSlots: [], min: discardCount, max: discardCount,
        }),
      })
      return
    }
    if (resolution.step !== 'discard-cost') return
    const owner = playerOf(host.state, ownerId)
    const targetIds = resolution.data.targetIds as PlayerId[]
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const discardCount = targetIds.length - 1
    const fromByCard = cardIds.map((cardId) => ({ cardId, from: locateOwnedCard(host.state, ownerId, cardId) }))
    if (!owner?.alive || targetIds.length < 2 || cardIds.length !== discardCount
      || new Set(cardIds).size !== cardIds.length || fromByCard.some(({ from }) => !from || from.kind === 'judgingArea' || from.kind === 'characterPile')) return
    for (const { cardId, from } of fromByCard) {
      if (!from) continue
      moveCard(host.state, cardId, from, { kind: 'discardPile' })
      if (from.kind === 'equipment') handleEquipmentLost(host as never, ownerId, cardId)
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: skill('lijian-mou-diaochan') },
        { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
    }
    const sorted = targetIds.filter((id) => playerOf(host.state, id)?.alive)
      .sort((left, right) => playerOf(host.state, left)!.seat - playerOf(host.state, right)!.seat)
    ;(host.state as Batch51State).b51Lijian ??= {}
    ;(host.state as Batch51State).b51Lijian![ownerId] = { targetIds: sorted, index: 0 }
    host.queueSkill({ skillId: skill('lijian-mou-diaochan'), ownerId, step: 'next-duel', data: {} })
  },
})

const MOU_JIANGWEI_CHARGE = 'mouJiangweiTiaoxinCharge'
const MOU_JIANGWEI_SELECTED = 'mouJiangweiTiaoxinSelected'
const MOU_JIANGWEI_BEIFA = 'mouJiangweiBeifa'
const tiaoxinId = skill('tiaoxin-mou-jiangwei')
const zhijiId = skill('zhiji-mou-jiangwei')

function otherLivingPlayers(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
}

function queueNextTiaoxinTarget(host: SkillHost, ownerId: PlayerId): void {
  const entry = (host.state as Batch51State).b51Tiaoxin?.[ownerId]
  if (!entry) return
  while (entry.index < entry.targetIds.length && !playerOf(host.state, entry.targetIds[entry.index])?.alive) entry.index += 1
  if (entry.index >= entry.targetIds.length) {
    delete (host.state as Batch51State).b51Tiaoxin?.[ownerId]
    return
  }
  host.queueSkill({ skillId: tiaoxinId, ownerId, step: 'choose-response', data: { targetId: entry.targetIds[entry.index] }, allowDeadOwner: true })
}

registerSkillRuntime({
  id: tiaoxinId,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (owner) {
      owner.marks[MOU_JIANGWEI_CHARGE] = 4
      owner.marks[MOU_JIANGWEI_SELECTED] = 0
    }
  },
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const charge = owner?.marks[MOU_JIANGWEI_CHARGE] ?? 0
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId && charge > 0
      && otherLivingPlayers(state, ownerId).length > 0 && !usedThisPhase(state, ownerId, tiaoxinId)
      ? [{ id: `skill:${tiaoxinId}`, label: `挑衅：选择至多${Math.min(charge, otherLivingPlayers(state, ownerId).length)}名角色` }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${tiaoxinId}` || usedThisPhase(host.state, ownerId, tiaoxinId)) return
    const owner = playerOf(host.state, ownerId)
    const candidates = otherLivingPlayers(host.state, ownerId)
    const max = Math.min(owner?.marks[MOU_JIANGWEI_CHARGE] ?? 0, candidates.length)
    if (!owner?.alive || max < 1) return
    host.askSkill({ skillId: tiaoxinId, ownerId, step: 'select-targets', data: {},
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【挑衅】：选择至多X名其他角色（X为蓄力点数）', timeoutMs: 20_000, optional: false,
        candidateIds: candidates, min: 1, max,
      }),
    })
  },
  triggers: [
    { event: 'LoseCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; reason?: string; cardIds?: CardId[] }
      const owner = playerOf(host.state, ownerId)
      if (payload.playerId !== ownerId || payload.reason !== 'discard-phase' || context.event.phase !== 'discard' || !owner?.alive) return
      owner.marks[MOU_JIANGWEI_CHARGE] = Math.min(4, (owner.marks[MOU_JIANGWEI_CHARGE] ?? 0) + (payload.cardIds?.length ?? 0))
    } },
    { event: 'AfterCardUse', allowDeadOwner: true, handle(host, ownerId, context) {
      const payload = context.event.payload as { sourceSkillId?: string }
      if (payload.sourceSkillId !== tiaoxinId || !(host.state as Batch51State).b51Tiaoxin?.[ownerId]) return
      const entry = (host.state as Batch51State).b51Tiaoxin![ownerId]
      entry.index += 1
      queueNextTiaoxinTarget(host, ownerId)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-response') return
    const targetId = prompt.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    const choices = [
      ...(owner?.alive && target?.alive ? [{ id: 'slash', label: '对谋姜维使用一张无距离限制的【杀】' }] : []),
      ...(target?.zones.hand.length ? [{ id: 'give', label: '交给谋姜维一张牌' }] : []),
    ]
    if (!target?.alive) { queueNextTiaoxinTarget(host, ownerId); return }
    if (!choices.length) {
      const entry = (host.state as Batch51State).b51Tiaoxin?.[ownerId]
      if (entry) entry.index += 1
      queueNextTiaoxinTarget(host, ownerId)
      return
    }
    host.askSkill({ skillId: tiaoxinId, ownerId, step: 'choose-response', data: { targetId },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: targetId,
        prompt: '【挑衅】：选择一项', timeoutMs: 20_000, optional: false, options: choices,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as Batch51State
    if (resolution.step === 'select-targets') {
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const owner = playerOf(host.state, ownerId)
      const charge = owner?.marks[MOU_JIANGWEI_CHARGE] ?? 0
      if (!owner?.alive || targetIds.length < 1 || targetIds.length > charge || new Set(targetIds).size !== targetIds.length
        || targetIds.some((id) => id === ownerId || !playerOf(host.state, id)?.alive)) return
      markUsedThisPhase(host.state, ownerId, tiaoxinId)
      owner.marks[MOU_JIANGWEI_CHARGE] = charge - targetIds.length
      owner.marks[MOU_JIANGWEI_SELECTED] = (owner.marks[MOU_JIANGWEI_SELECTED] ?? 0) + targetIds.length
      state.b51Tiaoxin ??= {}
      state.b51Tiaoxin[ownerId] = { targetIds: [...targetIds], index: 0 }
      queueNextTiaoxinTarget(host, ownerId)
      return
    }
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'choose-response') {
      const optionId = (response.payload as { optionId?: string }).optionId
      const entry = state.b51Tiaoxin?.[ownerId]
      if (!entry || entry.targetIds[entry.index] !== targetId || !target?.alive) return
      if (optionId === 'slash' && owner?.alive) {
        const begun = beginVirtualSlash(host as never, { sourceId: targetId, targetId: ownerId, sourceSkillId: tiaoxinId })
        if (begun) return
      } else if (optionId === 'give' && target.zones.hand.length) {
        host.askSkill({ skillId: tiaoxinId, ownerId, step: 'give-card', data: { targetId },
          build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetId,
            prompt: '【挑衅】：交给谋姜维一张手牌', timeoutMs: 20_000, optional: false,
            purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      entry.index += 1
      queueNextTiaoxinTarget(host, ownerId)
      return
    }
    if (resolution.step === 'give-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const entry = state.b51Tiaoxin?.[ownerId]
      if (!entry || entry.targetIds[entry.index] !== targetId || !target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: tiaoxinId }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: tiaoxinId }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      const entry2 = state.b51Tiaoxin?.[ownerId]
      if (entry2) entry2.index += 1
      queueNextTiaoxinTarget(host, ownerId)
    }
  },
})

registerSkillRuntime({
  id: zhijiId,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      return (playerOf(state, ownerId)?.marks[MOU_JIANGWEI_SELECTED] ?? 0) >= 4
    },
    invoke(host, ownerId) {
      loseMaxHp(host, ownerId, 1, zhijiId)
      const candidates = host.state.players.filter((player) => player.alive).map((player) => player.id)
      if (!candidates.length) return
      host.askSkill({ skillId: zhijiId, ownerId, step: 'select-beifa-targets', data: {},
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【志继】：选择任意名角色获得“北伐”标记，直到你的下回合开始', timeoutMs: 20_000,
          optional: false, candidateIds: candidates, min: 0, max: candidates.length,
        }),
      })
    },
  },
  globalProhibitsSourceTarget(state, ownerId, sourceId, targetId) {
    const markedBy = (state as Batch51State).b51Beifa?.[ownerId]
    if (!markedBy?.includes(sourceId)) return false
    return targetId !== ownerId && targetId !== sourceId
  },
  triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
    const markedIds = (host.state as Batch51State).b51Beifa?.[ownerId] ?? []
    for (const markedId of markedIds) {
      const marked = playerOf(host.state, markedId)
      if (marked) delete marked.marks[MOU_JIANGWEI_BEIFA]
    }
    delete (host.state as Batch51State).b51Beifa?.[ownerId]
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'select-beifa-targets') return
    const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (new Set(targetIds).size !== targetIds.length || targetIds.some((id) => !playerOf(host.state, id)?.alive)) return
    const state = host.state as Batch51State
    state.b51Beifa ??= {}
    state.b51Beifa[ownerId] = [...targetIds]
    for (const targetId of targetIds) playerOf(host.state, targetId)!.marks[MOU_JIANGWEI_BEIFA] = 1
  },
})

export const HISTORICAL_BATCH51_CHARACTERS: readonly CharacterDefinition[] = [
  MOU_CAOCAO, MOU_CAOREN, MOU_ZHOUYU, MOU_ZHENJI, JIE_WUYI,
  JIE_ZHUZHI, MOU_DIAOCHAN, MOU_PANGTONG, MOU_LIUBEI, MOU_JIANGWEI,
]
