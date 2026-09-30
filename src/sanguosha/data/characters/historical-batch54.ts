import type { CharacterDefinition } from './types'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CardId, Suit } from '../../engine/types'
import { drawCards } from '../../engine/draw'
import { gainArmor } from '../../engine/armor'
import { resolveDamage, resolveDamageSequence } from '../../engine/damage'
import { getAttackRange, getDistance } from '../../engine/distance'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { giveCards } from '../../engine/hand-transfer'
import { pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { effectiveCardColor, effectiveCardSuit, isCardProtectedFromDiscard, isTargetProhibited, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest, DistributeCardsRequest } from '../../engine/requests'
import { resumeJudgmentResult } from '../../engine/judgment'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { revealedGeneralFactionOf } from '../../engine/general-slots'
import { beginPhysicalCard, finishPhysicalCard } from '../../engine/cards/host'
import { handleEquipmentLost } from '../../engine/equipment'
import { equipmentSlotsOf } from '../../engine/equipment-slots'
import { resumeTargetDamagePrevention } from '../../engine/damage'
import { skillIdsOf } from './standard'
import { INSTANT_TRICKS, instantTrickActions } from '../../engine/cards/tricks'
import { createVirtualTrick, virtualTrickChoices } from '../../engine/virtual-trick'
import { executeUseCardAction } from '../../engine/cards/basic'
import { flipCharacter } from '../../engine/character-state'
import { suppressSkill } from '../../engine/skill-suppression'
import { restoreCharacter } from '../../engine/character-state'
import { gainMaxHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { abolishedSlotsOf, restoreSlot } from '../../engine/equipment-slots'
import { grantSkill } from '../../engine/skills/runtime'
import { getCharacter } from './standard'

const B54 = ':b54'
const skill = (id: string) => `${id}${B54}`
const YJ_JIZHI = skill('jizhi-mou-huangyueying')
const YJ_QICAI = skill('qicai-mou-huangyueying')
const XQ_HONGYAN = skill('hongyan-mou-xiaoqiao')
const ML_YUXIANG = skill('yuxiang-muludawang')
const ML_SHOUFA = skill('shoufa-muludawang')
const ML_ZHOULIN = skill('zhoulin-muludawang')
const XD_GANGLIE = skill('ganglie-mou-xiahou-dun')
const XD_QINGJIAN = skill('qingjian-mou-xiahou-dun')
const HD_GONGQI = skill('gongqi-mou-handang')
const HD_JIEFAN = skill('jiefan-mou-handang')
const ZJ_HUANSHI = skill('huanshi-mou-zhugejin')
const LX_LIANYING = skill('lianying-mou-luxun')
const CP_XINGSHANG = skill('xingshang-mou-caopi')
const CP_SONGWEI = skill('songwei-mou-caopi')
const CP_FANGZHU = skill('fangzhu-mou-caopi')
const JX_WANSHA = skill('wansha-mou-jiaxu')
const JX_WEIMU = skill('weimu-mou-jiaxu')
const XQ_TIANXIANG = skill('tianxiang-mou-xiaoqiao')
const ZJ_BOJIAN = skill('bojian-sp-zhenji')
const ZJ_JIWEI = skill('jiwei-sp-zhenji')
const ZJ_HONGYUAN = skill('hongyuan-mou-zhugejin')
const LX_QIANXUN = skill('qianxun-mou-luxun')

type Batch54State = SanguoshaState & {
  b54YueyingDraws?: Record<PlayerId, { turnNumber: number; cardIds: CardId[] }>
  b54Mulu?: Record<PlayerId, { lastDealtTurn: number; receivedCount: number; forcedBeast?: BeastEffect; forcedUntilTurn?: number }>
  b54Xiahou?: Record<PlayerId, { damagedBy: PlayerId[]; usedAgainst: PlayerId[] }>
  b54Gongqi?: Record<PlayerId, { turnNumber: number; color: 'red' | 'black' }>
  b54LuxunLoss?: Record<PlayerId, { turnNumber: number; cardIds: CardId[] }>
  b54CaopiDamageTurn?: Record<PlayerId, number>
  b54CaopiUses?: Record<PlayerId, { turnNumber: number; count: number }>
  b54QicaiMarks?: Record<PlayerId, Array<{ ownerId: PlayerId; remaining: number }>>
  b54TianxiangMarks?: Record<PlayerId, Suit>
  b54TianxiangUses?: Record<PlayerId, { turnNumber: number; count: number }>
  b54ZhenjiPhase?: Record<PlayerId, { turnNumber: number; count: number; suits: Suit[]; usedCardIds: CardId[]; previous?: { count: number; suitCount: number } }>
  b54ZhenjiLost?: Record<PlayerId, { turnNumber: number; cardIds: CardId[] }>
  b54LuxunNames?: Record<PlayerId, string[]>
  b54LuxunReturnTurn?: Record<PlayerId, number>
  b54FangzhuLocks?: Record<PlayerId, Array<{ kind: 'response' | 'basic' | 'non-trick' | 'non-equipment'; armedAtTurn: number }>>
  b54JiefanDisabled?: PlayerId[]
  b54LuanwuUsed?: PlayerId[]
  b54JiaXuUpgrades?: Record<PlayerId, { wansha: number; weimu: number }>
  b54HongyuanMode?: 'identity' | 'ranked' | 'landlord'
  b54Mingzhe?: Record<PlayerId, { roundNumber: number; count: number }>
  b54JiaXuDyingUsed?: Record<PlayerId, number>
  b54JiaXuTargeted?: Record<PlayerId, { roundNumber: number; count: number }>
  b54LuanwuProgress?: Record<PlayerId, { actors: PlayerId[]; nextIndex: number; waitingForActor: PlayerId }>
}
type BeastEffect = 'leopard' | 'eagle' | 'bear' | 'rabbit'

const MOU_CAOPI: CharacterDefinition = {
  id: 'mou-caopi-b54', name: '谋·曹丕', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: skill('xingshang-mou-caopi'), name: '行殇', description: '当一名角色受到伤害后（每回合限一次）或死亡时，你获得两个“颂”标记（至多9个）。出牌阶段限两次，你移去任意数量的“颂”令一名角色执行对应操作：2个，复原武将牌或摸三张牌；3个，回复1点体力并增加1点体力上限，然后随机恢复一个被废除的装备栏（体力上限不大于9）；4个，追思一名已阵亡角色并获得其武将牌上除主公技外的技能，然后你失去“行殇”“放逐”“颂威”。' },
    { id: skill('fangzhu-mou-caopi'), name: '放逐', description: '出牌阶段限一次，若你有“行殇”，可移去“颂”令一名其他角色执行对应操作：2个，直到其下回合结束不能使用基本牌外的手牌；4个，直到其下回合结束不能响应另一名角色使用的牌；6个，令其技能失效或直到其下回合结束不能使用锦囊牌外的手牌；8个，其翻面或直到其下回合结束不能使用装备牌外的手牌。' },
    { id: skill('songwei-mou-caopi'), name: '颂威', description: '主公技，出牌阶段开始时，若你有“行殇”，你获得X个“颂”（X为其他魏势力角色数的两倍）。' },
  ],
}
const MOU_HUANGYUEYING: CharacterDefinition = {
  id: 'mou-huangyueying-b54', name: '谋·黄月英', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('jizhi-mou-huangyueying'), name: '集智', description: '锁定技，当你使用普通锦囊牌时，你摸一张牌；此牌本回合不计入手牌上限。' },
    { id: skill('qicai-mou-huangyueying'), name: '奇才', description: '你使用锦囊牌无距离限制。出牌阶段限一次，你可令一名其他角色装备一张手牌或弃牌堆的装备牌并获得“奇”标记；其接下来获得的三张普通锦囊牌须交给你。' },
  ],
}
const MOU_XIAOQIAO: CharacterDefinition = {
  id: 'mou-xiaoqiao-b54', name: '谋·小乔', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('tianxiang-mou-xiaoqiao'), name: '天香', description: '准备阶段清除所有“天香”标记并摸等量牌（团战额外+2）。出牌阶段限三次，你可将一张红手牌交给无“天香”标记的其他角色并赋予其花色标记。当你受到伤害时，可移除一名角色的“天香”标记：红桃防止此伤害并令其受到伤害来源造成的1点伤害；方块令其交给你两张牌。' },
    { id: skill('hongyan-mou-xiaoqiao'), name: '红颜', description: '锁定技，你的黑桃手牌视为红桃牌；黑桃判定牌视为红桃判定牌。红桃判定牌生效前，你可指定其花色。' },
  ],
}
const MULUDAWANG: CharacterDefinition = {
  id: 'muludawang-b54', name: '木鹿大王', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: ML_SHOUFA, name: '兽法', description: '身份、团战：当你于一名角色的回合内首次造成伤害后，你可以选择距离你2以内的一名角色；每回合限5次，当你受到伤害后，你可以选择与你距离2以外的一名角色。其随机执行一种效果：豹，其受到1点无来源伤害；鹰，你随机获得其一张牌；熊，你随机弃置其装备区一张牌；兔，其摸一张牌。' },
    { id: ML_ZHOULIN, name: '咒鳞', description: '限定技，出牌阶段，若你有“兽法”技能，则你可发动此技能：你获得2点护甲并选择一种野兽效果，然后直到你的下回合开始时，“兽法”选择的角色必定执行你所选择的野兽效果。' },
    { id: ML_YUXIANG, name: '御象', description: '锁定技。若你有护甲，则：你计算与其他角色距离时，始终-1；其他角色计算与你距离时，始终+1；你受到火焰伤害时，此伤害+1。' },
  ],
}
const MOU_XIAHOU_DUN: CharacterDefinition = {
  id: 'mou-xiahou-dun-b54', name: '谋·夏侯惇', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: skill('ganglie-mou-xiahou-dun'), name: '刚烈', description: '出牌阶段限一次，你可以选择任意名本局对你造成过伤害的角色，对其造成2点伤害；每局每名角色限一次。' },
    { id: skill('qingjian-mou-xiahou-dun'), name: '清俭', description: '锁定技，一张牌非因使用进入弃牌堆时，若你的“清俭”牌少于X张（X为体力值-1且至少为1），你将此牌置于武将牌上。出牌阶段结束时，你将这些牌分配给任意角色。' },
  ],
}
const MOU_HANDANG: CharacterDefinition = {
  id: 'mou-handang-b54', name: '谋·韩当', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: skill('gongqi-mou-handang'), name: '弓骑', description: '你的攻击范围+4。出牌阶段开始时，你可弃一张牌；若如此做，此阶段你使用的牌只能被虚拟牌或与弃牌颜色相同的手牌响应。' },
    { id: skill('jiefan-mou-handang'), name: '解烦', description: '出牌阶段限一次，你指定一名角色并选择一项：令当前攻击范围包含其的角色依次弃置一张牌；令其摸等同于此类角色数的牌；背水：此技能失效直至你杀死一名角色。' },
  ],
}
const MOU_LUXUN: CharacterDefinition = {
  id: 'mou-luxun-b54', name: '谋·陆逊', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('qianxun-mou-luxun'), name: '谦逊', description: '一张锦囊牌对你生效时，若其牌名未记录且你不是使用者，你记录之，然后可将至多X张牌置于武将牌上（X为记录牌名数，至多5）；若如此做，此回合结束时你获得这些牌。出牌阶段开始时，你可移去一个记录；若为普通锦囊牌名，可视为使用此牌。' },
    { id: skill('lianying-mou-luxun'), name: '连营', description: '其他角色的回合结束时，你可观看牌堆顶X张牌并将这些牌交给任意角色（X为你本回合失去的牌数，至多5）。' },
  ],
}
const SP_ZHENJI: CharacterDefinition = {
  id: 'sp-zhenji-b54', name: 'SP·甄姬', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('bojian-sp-zhenji'), name: '博鉴', description: '锁定技，出牌阶段结束时，若本阶段使用牌数与花色数均不同于上个出牌阶段，你摸一张牌；否则你将本阶段使用过且仍在弃牌堆的一张牌交给一名角色。' },
    { id: skill('jiwei-sp-zhenji'), name: '济危', description: '锁定技，其他角色回合结束时，若此回合有人失去过牌，你摸一张牌。准备阶段，若手牌数不少于存活人数且不少于体力值，你须将手牌中数量较多颜色的牌全部分配给其他角色（数量相同时选择一种颜色）。' },
  ],
}
const MOU_JIA_XU: CharacterDefinition = {
  id: 'mou-jiaxu-b54', name: '谋·贾诩', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('wansha-mou-jiaxu'), name: '完杀', description: '你的回合内，非濒死角色不能使用【桃】。每轮限一次，一名角色进入濒死时，你可选择其手牌（升级后为区域内）至多两张，然后其选择：你将这些牌分配给其以外角色；或弃置所有未被选择的牌。' },
    { id: skill('luanwu-mou-jiaxu'), name: '乱武', description: '限定技，出牌阶段令所有其他角色依次对距离最近的另一名其他角色使用【杀】，否则失去1点体力。每有角色因此失去体力，你选择升级“完杀”或“帷幕”。' },
    { id: skill('weimu-mou-jiaxu'), name: '帷幕', description: '一级：锁定技，你成为黑色锦囊牌目标时取消之。二级：此外，每轮开始时，若你上一轮成为其他角色使用牌的目标次数不大于一次，你从弃牌堆随机获得一张黑色锦囊牌或防具牌。' },
  ],
}
const MOU_ZHUGEJIN: CharacterDefinition = {
  id: 'mou-zhugejin-b54', name: '谋·诸葛瑾', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: skill('huanshi-mou-zhugejin'), name: '缓释', description: '一名角色的判定牌生效前，你可观看牌堆顶一张牌，然后用此牌代替之，或用手牌中的一张替换之。' },
    { id: skill('hongyuan-mou-zhugejin'), name: '弘援', description: '蓄力技（1/3）。当你一次获得不少于两张牌时，可消耗1点蓄力点令至多两名角色各摸一张牌；当其他角色一次失去不少于两张牌时，可消耗1点蓄力点令其摸牌（军争摸一张，排位/斗地主摸两张）。' },
    { id: skill('mingzhe-mou-zhugejin'), name: '明哲', description: '锁定技，每轮限两次。当你于回合外失去牌时，选择一名角色；若其拥有蓄力技，其获得1点蓄力点；若失去的牌中有非基本牌，其摸一张牌。' },
  ],
}

export const HISTORICAL_BATCH54_CHARACTERS: readonly CharacterDefinition[] = [
  MOU_CAOPI, MOU_HUANGYUEYING, MOU_XIAOQIAO, MULUDAWANG, MOU_XIAHOU_DUN,
  MOU_HANDANG, MOU_LUXUN, SP_ZHENJI, MOU_JIA_XU, MOU_ZHUGEJIN,
]

function gainSong(host: SkillHost, ownerId: PlayerId, count: number): void {
  const owner = host.state.players.find((player) => player.id === ownerId)
  if (!owner?.alive) return
  const before = owner.marks['颂'] ?? 0
  const gained = Math.max(0, Math.min(count, 9 - before))
  if (!gained) return
  owner.marks['颂'] = before + gained
  host.dispatch('SkillActivated', { skillId: CP_XINGSHANG, skillName: '行殇', playerId: ownerId, gainedMarks: gained, mark: '颂' }, { sourceId: ownerId })
}

// 【行殇】的资源触发：全场每回合首次受到伤害时曹丕获得2“颂”；任何角色死亡时
// 另获得2“颂”。“颂”上限为9，回合限制只约束受伤分支，不吞死亡分支。
registerSkillRuntime({ id: CP_XINGSHANG,
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    const current = (state as Batch54State).b54CaopiUses?.[ownerId]
    const used = current?.turnNumber === state.turnNumber ? current.count : 0
    return owner?.alive && owner.characterId === MOU_CAOPI.id && !owner.characterSkillsDisabled
      && state.currentPlayerId === ownerId && state.phase === 'play' && (owner.marks['颂'] ?? 0) >= 2 && used < 2
      ? [{ id: `skill:${CP_XINGSHANG}`, label: `行殇：移去“颂”执行效果（${used}/2）` }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${CP_XINGSHANG}`) return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    const current = (host.state as Batch54State).b54CaopiUses?.[ownerId]
    if (!owner || (owner.marks['颂'] ?? 0) < 2 || (current?.turnNumber === host.state.turnNumber && current.count >= 2)) return
    const candidates = host.state.players.filter((player) => player.alive).map((player) => player.id)
    host.askSkill({ skillId: CP_XINGSHANG, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【行殇】：选择一名角色执行“颂”对应的效果',
      timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId) {
      const state = host.state as Batch54State
      state.b54CaopiDamageTurn ??= {}
      state.b54CaopiDamageTurn[ownerId] = -1
    } },
    { event: 'Damaged', handle(host, ownerId) {
      const state = host.state as Batch54State
      state.b54CaopiDamageTurn ??= {}
      if (state.b54CaopiDamageTurn[ownerId] === host.state.turnNumber) return
      state.b54CaopiDamageTurn[ownerId] = host.state.turnNumber
      gainSong(host, ownerId, 2)
    } },
    { event: 'Death', handle(host, ownerId) { gainSong(host, ownerId, 2) } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive)
      if (!owner || !target || (owner.marks['颂'] ?? 0) < 2) return
      const options = [
        ...(owner.marks['颂']! >= 2 ? [
          { id: 'restore', label: '移去2“颂”：令其复原武将牌' },
          { id: 'draw', label: '移去2“颂”：令其摸三张牌' },
        ] : []),
        ...(owner.marks['颂']! >= 3 && target.maxHp < 9 ? [{ id: 'recover-maxhp', label: '移去3“颂”：令其回复1点体力、增加1点体力上限并随机恢复一个废除的装备栏' }] : []),
        ...(owner.marks['颂']! >= 4 && target.id === ownerId
          && host.state.players.some((player) => !player.alive && (player.characterId || player.deputyCharacterId))
          ? [{ id: 'memory', label: '移去4“颂”：追思一名阵亡角色并获得其非主公技，然后失去行殇、放逐、颂威' }] : []),
      ]
      host.askSkill({ skillId: CP_XINGSHANG, ownerId, step: 'effect', data: { targetId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【行殇】：选择对${target.nickname}执行的“颂”效果`,
        timeoutMs: 25_000, optional: false, options,
      }) })
      return
    }
    if (resolution.step === 'effect') {
      const choice = (response.payload as { optionId?: string }).optionId
      const targetId = resolution.data.targetId as PlayerId
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      const cost = choice === 'restore' || choice === 'draw' ? 2 : choice === 'recover-maxhp' ? 3 : choice === 'memory' ? 4 : 0
      const usage = (host.state as Batch54State).b54CaopiUses?.[ownerId]
      if (!owner || !target || !choice || !cost || (owner.marks['颂'] ?? 0) < cost
        || (usage?.turnNumber === host.state.turnNumber && usage.count >= 2)) return
      if (choice === 'memory') {
        const deadCharacters = host.state.players.filter((player) => !player.alive)
          .flatMap((player) => [player.characterId, player.deputyCharacterId].filter((characterId): characterId is string => Boolean(characterId)))
          .filter((characterId) => Boolean(getCharacter(characterId)))
        if (!deadCharacters.length || targetId !== ownerId) return
        host.askSkill({ skillId: CP_XINGSHANG, ownerId, step: 'memory-character', data: {}, build: (id): ChooseOptionRequest => ({
          id, kind: 'choose-option', playerId: ownerId, prompt: '【行殇】：选择一张阵亡武将牌追思', timeoutMs: 25_000, optional: false,
          options: [...new Set(deadCharacters)].map((characterId) => ({ id: characterId, label: getCharacter(characterId)!.name })),
        }) })
        return
      }
      owner.marks['颂'] = (owner.marks['颂'] ?? 0) - cost
      const state = host.state as Batch54State
      const uses = state.b54CaopiUses ??= {}
      uses[ownerId] = { turnNumber: host.state.turnNumber, count: (usage?.turnNumber === host.state.turnNumber ? usage.count : 0) + 1 }
      if (choice === 'restore') restoreCharacter(host as never, targetId, CP_XINGSHANG)
      else if (choice === 'draw') {
        const cards = drawCards(host.state, host.rng, targetId, 3, (name, payload) => host.dispatch(name, payload))
        if (cards.length) host.dispatch('GainCard', { playerId: targetId, cardIds: cards, reason: CP_XINGSHANG }, { sourceId: ownerId, targetId, cardIds: cards })
      } else if (choice === 'recover-maxhp') {
        recover(host as never, targetId, 1, ownerId)
        gainMaxHp(host as never, targetId, 1, CP_XINGSHANG, 9)
        const slots = abolishedSlotsOf(host.state, targetId)
        if (slots.length) restoreSlot(host.state, targetId, host.rng.pick(slots))
      }
      return
    }
    if (resolution.step === 'memory-character') {
      const characterId = (response.payload as { optionId?: string }).optionId
      const character = characterId && getCharacter(characterId)
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner || !character || !host.state.players.some((player) => !player.alive && (player.characterId === characterId || player.deputyCharacterId === characterId))) return
      const skills = character.skills.filter((entry) => !entry.description.includes('主公技')).map((entry) => entry.id)
      for (const skillId of skills) grantSkill(host.state, ownerId, skillId)
      owner.permanentlyLostSkills ??= []
      for (const skillId of [CP_XINGSHANG, CP_FANGZHU, CP_SONGWEI])
        if (!owner.permanentlyLostSkills.includes(skillId)) owner.permanentlyLostSkills.push(skillId)
      owner.marks['颂'] = Math.max(0, (owner.marks['颂'] ?? 0) - 4)
      const state = host.state as Batch54State
      const uses = state.b54CaopiUses ??= {}
      const current = uses[ownerId]
      uses[ownerId] = { turnNumber: host.state.turnNumber, count: (current?.turnNumber === host.state.turnNumber ? current.count : 0) + 1 }
    }
  },
})

// 【颂威】仅在主公的出牌阶段开始、且保有【行殇】时，按当前存活的魏势力角色计数。
registerSkillRuntime({ id: CP_SONGWEI,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = host.state.players.find((player) => player.id === ownerId)
    if (!owner?.alive || owner.identity !== 'lord' || phase.playerId !== ownerId || phase.phase !== 'play') return
    if (!owner.characterId || owner.characterId !== MOU_CAOPI.id) return
    const count = host.state.players.filter((player) => player.alive && player.id !== ownerId && revealedGeneralFactionOf(player) === 'wei').length * 2
    gainSong(host, ownerId, count)
  } }],
})

registerSkillRuntime({ id: CP_FANGZHU,
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    return owner?.alive && owner.characterId === MOU_CAOPI.id && !owner.characterSkillsDisabled
      && state.currentPlayerId === ownerId && state.phase === 'play' && (owner.marks['颂'] ?? 0) >= 2
      && !usedThisPhase(state, ownerId, CP_FANGZHU)
      ? [{ id: `skill:${CP_FANGZHU}`, label: '放逐：移去“颂”令一名其他角色执行效果' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${CP_FANGZHU}` || usedThisPhase(host.state, ownerId, CP_FANGZHU)) return
    const owner = host.state.players.find((player) => player.id === ownerId)
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
    if (!owner?.alive || !candidates.length) return
    host.askSkill({ skillId: CP_FANGZHU, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【放逐】：选择一名其他角色',
      timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  triggers: [{ event: 'TurnEnd', handle(host, _ownerId, context) {
    const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (!playerId) return
    const state = host.state as Batch54State
    const locks = state.b54FangzhuLocks?.[playerId]
    if (locks) {
      const remaining = locks.filter((lock) => !(host.state.turnNumber > lock.armedAtTurn))
      if (remaining.length) state.b54FangzhuLocks![playerId] = remaining
      else delete state.b54FangzhuLocks![playerId]
    }
  } }],
  prohibitsCardUse(state, _ownerId, context) {
    const locks = (state as Batch54State).b54FangzhuLocks?.[context.userId] ?? []
    for (const lock of locks) {
      if (!context.cardIds?.length) continue
      const player = state.players.find((candidate) => candidate.id === context.userId)
      if (!player) continue
      for (const cardId of context.cardIds) {
        if (!player.zones.hand.includes(cardId)) continue
        const category = state.cards[cardId]?.category
        if (lock.kind === 'basic' && category !== 'basic') return true
        if (lock.kind === 'non-trick' && category !== 'trick') return true
        if (lock.kind === 'non-equipment' && category !== 'equipment') return true
      }
    }
    return false
  },
  prohibitsCardResponse(state, _ownerId, responderId) {
    return ((state as Batch54State).b54FangzhuLocks?.[responderId] ?? [])
      .some((lock) => lock.kind === 'response')
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive)
      const marks = owner?.marks['颂'] ?? 0
      if (!owner || !target || !targetId || targetId === ownerId || usedThisPhase(host.state, ownerId, CP_FANGZHU)) return
      const options = [
        ...(marks >= 2 ? [{ id: 'basic', label: '移去2“颂”：其下回合结束前不能使用非基本牌手牌' }] : []),
        ...(marks >= 4 ? [{ id: 'response', label: '移去4“颂”：其下回合结束前不能响应其他角色使用的牌' }] : []),
        ...(marks >= 6 ? [
          { id: 'all-skills', label: '移去6“颂”：其武将技能失效至其下回合结束' },
          { id: 'non-trick', label: '移去6“颂”：其下回合结束前不能使用非锦囊手牌' },
        ] : []),
        ...(marks >= 8 ? [
          { id: 'flip', label: '移去8“颂”：令其翻面' },
          { id: 'non-equipment', label: '移去8“颂”：其下回合结束前不能使用非装备手牌' },
        ] : []),
      ]
      host.askSkill({ skillId: CP_FANGZHU, ownerId, step: 'effect', data: { targetId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【放逐】：选择对${target.nickname}执行的效果`,
        timeoutMs: 25_000, optional: false, options,
      }) })
      return
    }
    if (resolution.step !== 'effect') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    const targetId = resolution.data.targetId as PlayerId
    const target = host.state.players.find((player) => player.id === targetId && player.alive)
    const choice = (response.payload as { optionId?: string }).optionId
    const costs: Record<string, number> = { basic: 2, response: 4, 'all-skills': 6, 'non-trick': 6, flip: 8, 'non-equipment': 8 }
    const cost = choice ? costs[choice] : undefined
    if (!owner || !target || !choice || !cost || (owner.marks['颂'] ?? 0) < cost || usedThisPhase(host.state, ownerId, CP_FANGZHU)) return
    owner.marks['颂'] -= cost
    markUsedThisPhase(host.state, ownerId, CP_FANGZHU)
    if (choice === 'flip') {
      flipCharacter(host as never, targetId, CP_FANGZHU)
      return
    }
    if (choice === 'all-skills') {
      suppressSkill(host.state, { targetId, scope: 'all', sourceId: ownerId, sourceSkillId: CP_FANGZHU, armedAtTurn: host.state.turnNumber })
      return
    }
    const kind = choice === 'basic' ? 'basic' : choice === 'response' ? 'response'
      : choice === 'non-trick' ? 'non-trick' : choice === 'non-equipment' ? 'non-equipment' : null
    if (!kind) return
    const state = host.state as Batch54State
    state.b54FangzhuLocks ??= {}
    ;(state.b54FangzhuLocks[targetId] ??= []).push({ kind, armedAtTurn: host.state.turnNumber })
  },
})

// 【完杀】的公共出牌/救援拦截：回合内只禁止非濒死者替他人使用桃，
// 濒死者自救及贾诩本人救援仍合法。
registerSkillRuntime({ id: JX_WANSHA,
  prohibitsCardUse(state, ownerId, context) {
    return state.currentPlayerId === ownerId && context.cardName === '桃'
      && context.userId !== ownerId && context.userId !== context.dyingPlayerId
  },
  onGameStart(host, ownerId) {
    const state = host.state as Batch54State
    state.b54JiaXuUpgrades ??= {}
    state.b54JiaXuUpgrades[ownerId] ??= { wansha: 1, weimu: 1 }
  },
  triggers: [{ event: 'EnterDying', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId }
    const target = payload.playerId && host.state.players.find((player) => player.id === payload.playerId && player.alive)
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!target || !owner || target.id === ownerId) return
    const state = host.state as Batch54State
    if (state.b54JiaXuDyingUsed?.[ownerId] === host.state.roundNumber) return
    const upgrades = state.b54JiaXuUpgrades?.[ownerId] ?? { wansha: 1, weimu: 1 }
    const cards = upgrades.wansha >= 2
      ? [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)), ...target.zones.judgingArea]
      : [...target.zones.hand]
    if (!cards.length) return
    state.b54JiaXuDyingUsed ??= {}
    state.b54JiaXuDyingUsed[ownerId] = host.state.roundNumber
    host.queueSkill({ skillId: JX_WANSHA, ownerId, step: 'dying-invoke', data: { targetId: target.id, cardIds: cards, level: upgrades.wansha } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'dying-invoke') return
    const targetId = prompt.data.targetId as PlayerId
    if (!host.state.players.some((player) => player.id === targetId && player.alive)) return
    host.askSkill({ skillId: JX_WANSHA, ownerId, step: 'dying-invoke', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【完杀】：是否观看濒死角色的牌并选择至多两张？', timeoutMs: 25_000,
      optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId
    const target = host.state.players.find((player) => player.id === targetId && player.alive)
    if (!target) return
    if (resolution.step === 'dying-invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const cardIds = (resolution.data.cardIds as CardId[]).filter((id) => locateOwnedCard(host.state, targetId, id))
      host.askSkill({ skillId: JX_WANSHA, ownerId, step: 'dying-cards', data: { targetId, cardIds }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【完杀】：选择其中至多两张牌（可以不选）', timeoutMs: 25_000,
        optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: Math.min(2, cardIds.length),
      }) })
      return
    }
    if (resolution.step === 'dying-cards') {
      const allowed = new Set(resolution.data.cardIds as CardId[])
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].filter((id) => allowed.has(id) && locateOwnedCard(host.state, targetId, id)).slice(0, 2)
      host.askSkill({ skillId: JX_WANSHA, ownerId, step: 'dying-choice', data: { targetId, selected, allCards: resolution.data.cardIds }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: targetId, prompt: '【完杀】：濒死者选择一项', timeoutMs: 25_000, optional: false,
        options: [{ id: 'give', label: '由贾诩将被选择的牌分配给你以外的角色' }, { id: 'discard', label: '弃置所有未被选择的牌' }],
      }) })
      return
    }
    if (resolution.step === 'dying-distribute') {
      const allowed = new Set(resolution.data.selected as CardId[])
      const assignments = (response.payload as { assignments?: Array<{ cardId?: CardId; recipientId?: PlayerId }> }).assignments ?? []
      const seen = new Set<CardId>()
      for (const assignment of assignments) {
        const cardId = assignment.cardId
        const recipientId = assignment.recipientId
        const recipient = recipientId && host.state.players.find((player) => player.id === recipientId && player.alive && player.id !== targetId)
        const from = cardId && locateOwnedCard(host.state, targetId, cardId)
        if (!cardId || !allowed.has(cardId) || seen.has(cardId) || !recipient || !from) continue
        seen.add(cardId)
        moveCard(host.state, cardId, from, { kind: 'hand', playerId: recipient.id })
        if (from.kind === 'equipment') handleEquipmentLost(host as never, targetId, cardId)
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: JX_WANSHA }, { sourceId: ownerId, targetId: recipient.id, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: recipient.id, cardIds: [cardId], reason: JX_WANSHA }, { sourceId: ownerId, targetId: recipient.id, cardIds: [cardId] })
      }
      return
    }
    if (resolution.step !== 'dying-choice') return
    const choice = (response.payload as { optionId?: string }).optionId
    const selected = resolution.data.selected as CardId[]
    if (choice === 'give') {
      const recipients = host.state.players.filter((player) => player.alive && player.id !== targetId).map((player) => player.id)
      if (!selected.length || !recipients.length) return
      host.askSkill({ skillId: JX_WANSHA, ownerId, step: 'dying-distribute', data: { targetId, selected }, build: (id): DistributeCardsRequest => ({
        id, kind: 'distribute-cards', playerId: ownerId, prompt: '【完杀】：将所选牌分配给濒死角色以外的角色', timeoutMs: 30_000,
        optional: false, cardIds: selected, recipientIds: recipients, min: selected.length, max: selected.length,
      }) })
    } else if (choice === 'discard') {
      const selectedSet = new Set(selected)
      const all = (resolution.data.allCards as CardId[]).filter((id) => !selectedSet.has(id))
      for (const cardId of all) {
        const from = locateOwnedCard(host.state, targetId, cardId)
        if (!from) continue
        moveCard(host.state, cardId, from, { kind: 'discardPile' }, { discardReason: 'discard' })
        if (from.kind === 'equipment') handleEquipmentLost(host as never, targetId, cardId)
      }
      if (all.length) host.dispatch('LoseCard', { playerId: targetId, cardIds: all, reason: JX_WANSHA }, { sourceId: ownerId, targetId, cardIds: all })
    }
  },
})

// 【帷幕】一级：只取消贾诩作为目标的黑色锦囊，不错误拦截黑色基本牌或装备牌。
registerSkillRuntime({ id: JX_WEIMU,
  prohibitsTarget(state, ownerId, _sourceId, cardName, cardId) {
    if (!cardId) return false
    const card = state.cards[cardId]
    return card?.category === 'trick' && card.color === 'black'
      && state.players.some((player) => player.id === ownerId && player.alive)
      && Boolean(cardName)
  },
  triggers: [
    { event: 'TargetSpecified', handle(host, ownerId, context) {
      const payload = context.event.payload as { targetIds?: PlayerId[] }
      if (!payload.targetIds?.includes(ownerId) || context.event.sourceId === ownerId) return
      const state = host.state as Batch54State
      state.b54JiaXuTargeted ??= {}
      const previous = state.b54JiaXuTargeted[ownerId]
      state.b54JiaXuTargeted[ownerId] = previous?.roundNumber === host.state.roundNumber
        ? { roundNumber: previous.roundNumber, count: previous.count + 1 }
        : { roundNumber: host.state.roundNumber, count: 1 }
    } },
    { event: 'RoundStart', handle(host, ownerId) {
      const state = host.state as Batch54State
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      const previousRound = state.b54JiaXuTargeted?.[ownerId]
      const grant = owner && (state.b54JiaXuUpgrades?.[ownerId]?.weimu ?? 1) >= 2
        && previousRound?.roundNumber === host.state.roundNumber - 1 && previousRound.count <= 1
      state.b54JiaXuTargeted ??= {}
      state.b54JiaXuTargeted[ownerId] = { roundNumber: host.state.roundNumber, count: 0 }
      if (!grant) return
      const eligible = host.state.zones.discardPile.filter((cardId) => {
        const card = host.state.cards[cardId]
        return card && ((card.category === 'trick' && effectiveCardColor(host.state, ownerId, cardId, skillIdsOf) === 'black')
          || (card.category === 'equipment' && card.equipmentSlot === 'armor'))
      })
      if (!eligible.length) return
      const cardId = host.rng.pick(eligible)
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: JX_WEIMU }, { targetId: ownerId, cardIds: [cardId] })
    } },
  ],
})

function zhenjiHistory(state: SanguoshaState, ownerId: PlayerId) {
  const mutable = state as Batch54State
  mutable.b54ZhenjiPhase ??= {}
  return mutable.b54ZhenjiPhase[ownerId] ??= { turnNumber: -1, count: 0, suits: [], usedCardIds: [], previous: { count: 0, suitCount: 0 } }
}

function rememberZhenjiLoss(state: SanguoshaState, ownerId: PlayerId, ids: readonly CardId[]): void {
  const mutable = state as Batch54State
  mutable.b54ZhenjiLost ??= {}
  const current = mutable.b54ZhenjiLost[ownerId]
  const entry = current?.turnNumber === state.turnNumber ? current : { turnNumber: state.turnNumber, cardIds: [] }
  for (const id of ids) if (!entry.cardIds.includes(id)) entry.cardIds.push(id)
  mutable.b54ZhenjiLost[ownerId] = entry
}

registerSkillRuntime({ id: ZJ_BOJIAN,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.playerId !== ownerId || phase.phase !== 'play') return
      const entry = zhenjiHistory(host.state, ownerId)
      entry.turnNumber = host.state.turnNumber
      entry.count = 0
      entry.suits = []
      entry.usedCardIds = []
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
      const entry = zhenjiHistory(host.state, ownerId)
      if (entry.turnNumber !== host.state.turnNumber) return
      entry.count += 1
      const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }
      const ids = payload.cardIds?.length ? payload.cardIds : payload.cardId ? [payload.cardId] : []
      for (const cardId of ids) {
        if (!entry.usedCardIds.includes(cardId)) entry.usedCardIds.push(cardId)
        const suit = effectiveCardSuit(host.state, ownerId, cardId, skillIdsOf)
        if (!entry.suits.includes(suit)) entry.suits.push(suit)
      }
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.playerId !== ownerId || phase.phase !== 'play') return
      const entry = zhenjiHistory(host.state, ownerId)
      const current = { count: entry.count, suitCount: entry.suits.length }
      const previous = entry.previous ?? { count: 0, suitCount: 0 }
      entry.previous = current
      if (current.count !== previous.count && current.suitCount !== previous.suitCount) {
        const drawn = drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
        if (drawn.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: drawn, reason: ZJ_BOJIAN }, { targetId: ownerId, cardIds: drawn })
        return
      }
      const available = entry.usedCardIds.filter((cardId) => host.state.zones.discardPile.includes(cardId))
      const recipients = host.state.players.filter((player) => player.alive).map((player) => player.id)
      if (!available.length || !recipients.length) return
      host.askSkill({ skillId: ZJ_BOJIAN, ownerId, step: 'choose-used-card', data: { cardIds: available }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【博鉴】：选择本阶段使用过且仍在弃牌堆的一张牌交给一名角色',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: available, hiddenCardSlots: [], min: 1, max: 1,
      }) })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-used-card') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const allowed = resolution.data.cardIds as CardId[]
      if (!cardId || !allowed.includes(cardId) || !host.state.zones.discardPile.includes(cardId)) return
      const targets = host.state.players.filter((player) => player.alive).map((player) => player.id)
      host.askSkill({ skillId: ZJ_BOJIAN, ownerId, step: 'recipient', data: { cardId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【博鉴】：选择获得此牌的角色',
        timeoutMs: 25_000, optional: false, candidateIds: targets, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'recipient') return
    const cardId = resolution.data.cardId as CardId
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive)
    if (!target || !host.state.zones.discardPile.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: target.id })
    host.dispatch('GainCard', { playerId: target.id, cardIds: [cardId], reason: ZJ_BOJIAN }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
  },
})

registerSkillRuntime({ id: ZJ_JIWEI,
  triggers: [
    { event: 'TurnStart', handle(host) {
      const state = host.state as Batch54State
      state.b54ZhenjiLost ??= {}
      for (const player of host.state.players) state.b54ZhenjiLost[player.id] = { turnNumber: host.state.turnNumber, cardIds: [] }
    } },
    { event: 'LoseCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId === ownerId) rememberZhenjiLoss(host.state, ownerId, payload.cardIds ?? [])
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[]; fromKind?: string }
      if (payload.fromKind === 'hand' || payload.fromKind === 'equipment')
        rememberZhenjiLoss(host.state, ownerId, payload.cardIds ?? (payload.cardId ? [payload.cardId] : []))
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId; fromKind?: string }
      if (payload.playerId === ownerId && (payload.fromKind === 'hand' || payload.fromKind === 'equipment') && payload.cardId)
        rememberZhenjiLoss(host.state, ownerId, [payload.cardId])
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const turn = context.event.payload as { playerId?: PlayerId }
      if (turn.playerId === ownerId) return
      const entry = (host.state as Batch54State).b54ZhenjiLost?.[ownerId]
      if (entry?.turnNumber !== host.state.turnNumber || !entry.cardIds.length) return
      const drawn = drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      if (drawn.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: drawn, reason: ZJ_JIWEI }, { targetId: ownerId, cardIds: drawn })
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = host.state.players.find((player) => player.id === ownerId)
      if (!owner?.alive || owner.characterId !== SP_ZHENJI.id || phase.playerId !== ownerId || phase.phase !== 'prepare') return
      const living = host.state.players.filter((player) => player.alive)
      if (owner.zones.hand.length < living.length || owner.zones.hand.length < owner.hp) return
      const red = owner.zones.hand.filter((id) => host.state.cards[id]?.color === 'red')
      const black = owner.zones.hand.filter((id) => host.state.cards[id]?.color === 'black')
      const distribute = (color: 'red' | 'black') => {
        const cardIds = owner.zones.hand.filter((id) => host.state.cards[id]?.color === color)
        const recipients = living.filter((player) => player.id !== ownerId).map((player) => player.id)
        if (!cardIds.length || !recipients.length) return
        host.askSkill({ skillId: ZJ_JIWEI, ownerId, step: 'distribute', data: { cardIds }, build: (id): DistributeCardsRequest => ({
          id, kind: 'distribute-cards', playerId: ownerId, prompt: `【济危】：将所有${color === 'red' ? '红色' : '黑色'}手牌分配给其他角色`,
          timeoutMs: 30_000, optional: false, cardIds, recipientIds: recipients, min: cardIds.length, max: cardIds.length,
        }) })
      }
      if (red.length === black.length) {
        host.askSkill({ skillId: ZJ_JIWEI, ownerId, step: 'color', build: (id): ChooseOptionRequest => ({
          id, kind: 'choose-option', playerId: ownerId, prompt: '【济危】：红黑手牌数量相同，选择分配一种颜色',
          timeoutMs: 25_000, optional: false, options: [{ id: 'red', label: '红色手牌' }, { id: 'black', label: '黑色手牌' }],
        }) })
      } else distribute(red.length > black.length ? 'red' : 'black')
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'color') {
      const color = (response.payload as { optionId?: string }).optionId
      if (color !== 'red' && color !== 'black') return
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner) return
      const cardIds = owner.zones.hand.filter((id) => host.state.cards[id]?.color === color)
      const recipientIds = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      if (!cardIds.length || !recipientIds.length) return
      host.askSkill({ skillId: ZJ_JIWEI, ownerId, step: 'distribute', data: { cardIds }, build: (id): DistributeCardsRequest => ({
        id, kind: 'distribute-cards', playerId: ownerId, prompt: `【济危】：将所有${color === 'red' ? '红色' : '黑色'}手牌分配给其他角色`,
        timeoutMs: 30_000, optional: false, cardIds, recipientIds, min: cardIds.length, max: cardIds.length,
      }) })
      return
    }
    if (resolution.step !== 'distribute') return
    const allowed = new Set(resolution.data.cardIds as CardId[])
    const assignments = (response.payload as { assignments?: Array<{ cardId?: CardId; recipientId?: PlayerId }> }).assignments ?? []
    const moved = new Map<PlayerId, CardId[]>()
    const seen = new Set<CardId>()
    for (const assignment of assignments) {
      const cardId = assignment.cardId
      const recipientId = assignment.recipientId
      const recipient = recipientId && host.state.players.find((player) => player.id === recipientId && player.alive && player.id !== ownerId)
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner || !cardId || seen.has(cardId) || !allowed.has(cardId) || !recipient || !owner.zones.hand.includes(cardId)) continue
      seen.add(cardId)
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: recipient.id })
      const cards = moved.get(recipient.id) ?? []
      cards.push(cardId)
      moved.set(recipient.id, cards)
    }
    for (const [recipientId, cardIds] of moved) {
      host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: ZJ_JIWEI }, { sourceId: ownerId, targetId: recipientId, cardIds })
      host.dispatch('GainCard', { playerId: recipientId, cardIds, reason: ZJ_JIWEI }, { sourceId: ownerId, targetId: recipientId, cardIds })
      host.dispatch('CardGiven', { fromId: ownerId, toId: recipientId, cardIds, reason: ZJ_JIWEI }, { sourceId: ownerId, targetId: recipientId, cardIds })
    }
  },
})

registerSkillRuntime({ id: ZJ_HONGYUAN,
  onGameStart(host, ownerId) {
    const owner = host.state.players.find((player) => player.id === ownerId)
    if (owner && owner.marks['蓄力点'] === undefined) owner.marks['蓄力点'] = 1
    if (owner) owner.marks['蓄力点'] = Math.min(3, owner.marks['蓄力点'] ?? 1)
  },
  triggers: [
    { event: 'GainCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId || (payload.cardIds?.length ?? 0) < 2) return
      const owner = host.state.players.find((player) => player.id === ownerId)
      if (!owner?.alive || (owner.marks['蓄力点'] ?? 0) < 1) return
      host.queueSkill({ skillId: ZJ_HONGYUAN, ownerId, step: 'gain', data: {} })
    } },
    { event: 'LoseCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (!payload.playerId || payload.playerId === ownerId || (payload.cardIds?.length ?? 0) < 2) return
      const owner = host.state.players.find((player) => player.id === ownerId)
      if (!owner?.alive || (owner.marks['蓄力点'] ?? 0) < 1) return
      host.queueSkill({ skillId: ZJ_HONGYUAN, ownerId, step: 'loss', data: { targetId: payload.playerId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner || (owner.marks['蓄力点'] ?? 0) < 1) return
    if (prompt.step === 'gain') {
      const targets = host.state.players.filter((player) => player.alive).map((player) => player.id)
      if (!targets.length) return
      host.askSkill({ skillId: ZJ_HONGYUAN, ownerId, step: 'gain-targets', build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【弘援】：消耗1点蓄力点，令至多两名角色各摸一张牌',
        timeoutMs: 25_000, optional: true, candidateIds: targets, min: 0, max: Math.min(2, targets.length),
      }) })
    } else if (prompt.step === 'loss') {
      const targetId = prompt.data.targetId as PlayerId
      if (!host.state.players.some((player) => player.id === targetId && player.alive)) return
      host.askSkill({ skillId: ZJ_HONGYUAN, ownerId, step: 'loss-invoke', data: { targetId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【弘援】：是否消耗1点蓄力点令失去牌的角色摸一张牌？',
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner || (owner.marks['蓄力点'] ?? 0) < 1) return
    if (resolution.step === 'gain-targets') {
      const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
        .filter((id) => host.state.players.some((player) => player.id === id && player.alive)).slice(0, 2)
      if (!targetIds.length) return
      owner.marks['蓄力点'] -= 1
      for (const targetId of targetIds) {
        const cards = drawCards(host.state, host.rng, targetId, 1, (name, payload) => host.dispatch(name, payload))
        if (cards.length) host.dispatch('GainCard', { playerId: targetId, cardIds: cards, reason: ZJ_HONGYUAN }, { sourceId: ownerId, targetId, cardIds: cards })
      }
      return
    }
    if (resolution.step === 'loss-invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = resolution.data.targetId as PlayerId
      if (!host.state.players.some((player) => player.id === targetId && player.alive)) return
      owner.marks['蓄力点'] -= 1
      const cards = drawCards(host.state, host.rng, targetId, 1, (name, payload) => host.dispatch(name, payload))
      if (cards.length) host.dispatch('GainCard', { playerId: targetId, cardIds: cards, reason: ZJ_HONGYUAN }, { sourceId: ownerId, targetId, cardIds: cards })
    }
  },
})

function hasChargeSkill(state: SanguoshaState, playerId: PlayerId): boolean {
  const player = state.players.find((entry) => entry.id === playerId)
  if (!player) return false
  return [player.characterId, player.deputyCharacterId].filter((id): id is string => Boolean(id))
    .some((characterId) => getCharacter(characterId)?.skills.some((entry) => entry.description.includes('蓄力技')))
}

function gainChargePoint(state: SanguoshaState, playerId: PlayerId): void {
  const target = state.players.find((entry) => entry.id === playerId)
  if (!target) return
  const descriptions = [target.characterId, target.deputyCharacterId].filter((id): id is string => Boolean(id))
    .flatMap((characterId) => getCharacter(characterId)?.skills.map((entry) => entry.description) ?? [])
  const max = descriptions.map((description) => description.match(/蓄力技[（(]\d+\/(\d+)[）)]/u)?.[1])
    .filter((value): value is string => Boolean(value)).map(Number).reduce((largest, value) => Math.max(largest, value), 99)
  target.marks['蓄力点'] = Math.min(max, (target.marks['蓄力点'] ?? 0) + 1)
}

registerSkillRuntime({ id: skill('mingzhe-mou-zhugejin'),
  triggers: [{ event: 'LoseCard', handle(host, ownerId, context) {
    if (host.state.currentPlayerId === ownerId) return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    if (!owner || payload.playerId !== ownerId || !(payload.cardIds?.length)) return
    const state = host.state as Batch54State
    state.b54Mingzhe ??= {}
    const use = state.b54Mingzhe[ownerId]
    const count = use?.roundNumber === host.state.roundNumber ? use.count : 0
    if (count >= 2) return
    state.b54Mingzhe[ownerId] = { roundNumber: host.state.roundNumber, count: count + 1 }
    host.queueSkill({ skillId: skill('mingzhe-mou-zhugejin'), ownerId, step: 'choose-beneficiary', data: { cardIds: payload.cardIds } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-beneficiary') return
    const candidates = host.state.players.filter((player) => player.alive)
    if (!candidates.length) return
    host.askSkill({ skillId: skill('mingzhe-mou-zhugejin'), ownerId, step: 'beneficiary', data: prompt.data, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【明哲】：选择一名角色；其有蓄力技则获得1点蓄力点，你失去的牌中有非基本牌则其摸一张牌',
      timeoutMs: 25_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1,
    }) })
  },
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'beneficiary') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive)
    if (!target) return
    const cardIds = resolution.data.cardIds as CardId[]
    if (hasChargeSkill(host.state, target.id)) gainChargePoint(host.state, target.id)
    if (cardIds.some((cardId) => host.state.cards[cardId]?.category !== 'basic')) {
      const cards = drawCards(host.state, host.rng, target.id, 1, (name, payload) => host.dispatch(name, payload))
      if (cards.length) host.dispatch('GainCard', { playerId: target.id, cardIds: cards, reason: skill('mingzhe-mou-zhugejin') }, { sourceId: response.playerId, targetId: target.id, cardIds: cards })
    }
  },
})

// 谋·黄月英【集智】：只对实际使用的普通锦囊牌触发，摸到的牌绑定本回合手牌上限豁免。
const delayedTricks = new Set(['乐不思蜀', '兵粮寸断', '闪电'])
registerSkillRuntime({ id: YJ_JIZHI,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; asCardName?: string }
    const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
    const cardName = payload.asCardName ?? card?.name ?? payload.cardName
    const isTrick = card?.category === 'trick' || Object.values(host.state.cards).some((candidate) => candidate.name === cardName && candidate.category === 'trick')
    if (!cardName || !isTrick || delayedTricks.has(cardName)) return
    const drawn = drawCards(host.state, host.rng, ownerId, 1)
    if (!drawn.length) return
    const state = host.state as Batch54State
    const entry = state.b54YueyingDraws?.[ownerId]
    state.b54YueyingDraws ??= {}
    state.b54YueyingDraws[ownerId] = {
      turnNumber: host.state.turnNumber,
      cardIds: [...(entry?.turnNumber === host.state.turnNumber ? entry.cardIds : []), ...drawn],
    }
    host.dispatch('GainCard', { playerId: ownerId, cardIds: drawn, reason: YJ_JIZHI }, { targetId: ownerId, cardIds: drawn })
  } }, { event: 'TurnStart', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
    const state = host.state as Batch54State
    if (state.b54YueyingDraws) delete state.b54YueyingDraws[ownerId]
  } }],
  handLimitExempt(state, ownerId, cardId) {
    const entry = (state as Batch54State).b54YueyingDraws?.[ownerId]
    return entry?.turnNumber === state.turnNumber && entry.cardIds.includes(cardId)
  },
})
function qicaiEquipmentOptions(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = state.players.find((player) => player.id === ownerId)
  if (!owner) return []
  return [...owner.zones.hand, ...state.zones.discardPile]
    .filter((cardId) => state.cards[cardId]?.category === 'equipment' && Boolean(state.cards[cardId]?.equipmentSlot))
}

function qicaiEligibleTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players.filter((player) => player.alive && player.id !== ownerId
    && equipmentSlotsOf(state, player.id).some((slot) => !player.zones.equipment[slot])).map((player) => player.id)
}

function takeQicaiTricks(host: SkillHost, recipientId: PlayerId, cardIds: readonly CardId[]): void {
  const state = host.state as Batch54State
  const entries = state.b54QicaiMarks?.[recipientId]
  if (!entries?.length) return
  for (const cardId of cardIds) {
    if (!host.state.players.find((player) => player.id === recipientId)?.zones.hand.includes(cardId)) continue
    const card = host.state.cards[cardId]
    if (card?.category !== 'trick' || delayedTricks.has(card.name)) continue
    const entry = entries.find((candidate) => candidate.remaining > 0
      && host.state.players.some((player) => player.id === candidate.ownerId && player.alive))
    if (!entry) break
    entry.remaining -= 1
    const owner = host.state.players.find((player) => player.id === entry.ownerId)!
    moveCard(host.state, cardId, { kind: 'hand', playerId: recipientId }, { kind: 'hand', playerId: owner.id })
    host.dispatch('LoseCard', { playerId: recipientId, cardIds: [cardId], reason: YJ_QICAI }, { sourceId: owner.id, targetId: recipientId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: owner.id, cardIds: [cardId], reason: YJ_QICAI }, { sourceId: owner.id, targetId: owner.id, cardIds: [cardId] })
    host.dispatch('CardGiven', { fromId: recipientId, toId: owner.id, cardIds: [cardId], reason: YJ_QICAI }, { sourceId: owner.id, targetId: recipientId, cardIds: [cardId] })
  }
  state.b54QicaiMarks ??= {}
  state.b54QicaiMarks[recipientId] = entries.filter((entry) => entry.remaining > 0)
  if (!state.b54QicaiMarks[recipientId]!.length) delete state.b54QicaiMarks[recipientId]
}

registerSkillRuntime({ id: YJ_QICAI, ignoresTrickDistance: true,
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    return owner?.alive && owner.characterId === MOU_HUANGYUEYING.id && state.currentPlayerId === ownerId && state.phase === 'play'
      && !usedThisPhase(state, ownerId, YJ_QICAI) && qicaiEquipmentOptions(state, ownerId).length > 0 && qicaiEligibleTargets(state, ownerId).length > 0
      ? [{ id: `skill:${YJ_QICAI}`, label: '奇才：令一名其他角色装备一张装备牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${YJ_QICAI}` || usedThisPhase(host.state, ownerId, YJ_QICAI)) return
    const candidates = qicaiEligibleTargets(host.state, ownerId)
    if (!candidates.length) return
    host.askSkill({ skillId: YJ_QICAI, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【奇才】：选择一名其他角色装备一张手牌或弃牌堆中的装备牌',
      timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  triggers: [{ event: 'GainCard', handle(host, _ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    if (payload.playerId) takeQicaiTricks(host, payload.playerId, payload.cardIds ?? [])
  } }],
  resume(host, ownerId, resolution, response) {
    const owner = host.state.players.find((player) => player.id === ownerId)
    if (!owner?.alive || usedThisPhase(host.state, ownerId, YJ_QICAI)) return
    if (resolution.step === 'slot') {
      const cardId = resolution.data.cardId as CardId
      const targetId = resolution.data.targetId as PlayerId
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      const card = host.state.cards[cardId]
      const compatible = target && card?.equipmentSlot ? equipmentSlotsOf(host.state, targetId).filter((slot) => card.equipmentSlot === 'weapon'
        ? slot === 'weapon' || slot === 'weapon2' : slot === card.equipmentSlot) : []
      const slot = (response.payload as { optionId?: string }).optionId
      if (!target || !compatible.includes(slot as never)) return
      const from = owner.zones.hand.includes(cardId) ? { kind: 'hand' as const, playerId: ownerId }
        : host.state.zones.discardPile.includes(cardId) ? { kind: 'discardPile' as const } : null
      if (!from || !beginPhysicalCard(host as never, ownerId, cardId, [targetId], card.name, from, [cardId], YJ_QICAI)) return
      markUsedThisPhase(host.state, ownerId, YJ_QICAI)
      const replaced = target.zones.equipment[slot as keyof typeof target.zones.equipment]
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'equipment', playerId: targetId, slot: slot as never })
      if (replaced) handleEquipmentLost(host as never, targetId, replaced)
      finishPhysicalCard(host as never, ownerId, cardId, [targetId], false, card.name)
      target.marks['奇'] = (target.marks['奇'] ?? 0) + 1
      const state = host.state as Batch54State
      state.b54QicaiMarks ??= {}
      ;(state.b54QicaiMarks[targetId] ??= []).push({ ownerId, remaining: 3 })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive)
      if (!target || !qicaiEligibleTargets(host.state, ownerId).includes(target.id)) return
      const cardIds = qicaiEquipmentOptions(host.state, ownerId)
      if (!cardIds.length) return
      host.askSkill({ skillId: YJ_QICAI, ownerId, step: 'equipment', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【奇才】：选择一张牌置入${target.nickname}的装备区`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'equipment') return
    const targetId = resolution.data.targetId as PlayerId
    const target = host.state.players.find((player) => player.id === targetId && player.alive)
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const card = cardId ? host.state.cards[cardId] : undefined
    const from = cardId && owner.zones.hand.includes(cardId) ? { kind: 'hand' as const, playerId: ownerId }
      : cardId && host.state.zones.discardPile.includes(cardId) ? { kind: 'discardPile' as const } : null
    if (!target || !cardId || !card?.equipmentSlot || !from || !qicaiEquipmentOptions(host.state, ownerId).includes(cardId)) return
    const compatible = equipmentSlotsOf(host.state, target.id).filter((slot) => card.equipmentSlot === 'weapon'
      ? slot === 'weapon' || slot === 'weapon2' : slot === card.equipmentSlot)
    if (!compatible.length) return
    const empty = compatible.filter((slot) => !target.zones.equipment[slot])
    const choices = empty.length ? empty : compatible
    if (choices.length > 1) {
      host.askSkill({ skillId: YJ_QICAI, ownerId, step: 'slot', data: { targetId: target.id, cardId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【奇才】：选择置入装备牌的装备栏', timeoutMs: 20_000, optional: false,
        options: choices.map((slot) => ({ id: slot, label: ({ weapon: '武器栏', weapon2: '第二武器栏', armor: '防具栏', offensiveHorse: '进攻坐骑栏', defensiveHorse: '防御坐骑栏', treasure: '宝物栏' })[slot] })),
      }) })
      return
    }
    const slot = choices[0]
    if (!beginPhysicalCard(host as never, ownerId, cardId, [target.id], card.name, from, [cardId], YJ_QICAI)) return
    markUsedThisPhase(host.state, ownerId, YJ_QICAI)
    const replaced = target.zones.equipment[slot]
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'equipment', playerId: target.id, slot })
    if (replaced) handleEquipmentLost(host as never, target.id, replaced)
    finishPhysicalCard(host as never, ownerId, cardId, [target.id], false, card.name)
    target.marks['奇'] = (target.marks['奇'] ?? 0) + 1
    const state = host.state as Batch54State
    state.b54QicaiMarks ??= {}
    ;(state.b54QicaiMarks[target.id] ??= []).push({ ownerId, remaining: 3 })
  },
})

// 【红颜】的牌色/判定花色覆盖通过统一牌面花色入口作用于用牌、响应与拼点。
registerSkillRuntime({ id: XQ_HONGYAN,
  cardSuit(_state, _ownerId, _cardId, printedSuit: Suit) { return printedSuit === 'spade' ? 'heart' : printedSuit },
  beforeJudgmentResult(host, ownerId, _cardId, suit) {
    if (suit !== 'heart' || !host.state.retrial || !host.state.players.some((player) => player.id === ownerId && player.alive)) return false
    host.askSkill({ skillId: XQ_HONGYAN, ownerId, step: 'result-suit', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【红颜】：将这张红桃判定牌的结果改为一种花色',
      timeoutMs: 20_000, optional: false,
      options: [{ id: 'spade', label: '黑桃' }, { id: 'heart', label: '红桃' }, { id: 'club', label: '梅花' }, { id: 'diamond', label: '方块' }],
    }) })
    return true
  },
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'result-suit') return
    const suit = (response.payload as { optionId?: string }).optionId
    if (suit !== 'spade' && suit !== 'heart' && suit !== 'club' && suit !== 'diamond') return
    resumeJudgmentResult(host as never, suit)
  },
})

function markedTianxiang(state: SanguoshaState): Array<{ playerId: PlayerId; suit: Suit }> {
  return Object.entries((state as Batch54State).b54TianxiangMarks ?? {})
    .filter(([playerId]) => state.players.some((player) => player.id === playerId && player.alive))
    .map(([playerId, suit]) => ({ playerId, suit }))
}

registerSkillRuntime({ id: XQ_TIANXIANG,
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    const use = (state as Batch54State).b54TianxiangUses?.[ownerId]
    const used = use?.turnNumber === state.turnNumber ? use.count : 0
    const canTarget = state.players.some((player) => player.alive && player.id !== ownerId && !((state as Batch54State).b54TianxiangMarks?.[player.id]))
    const hasRedHand = owner?.zones.hand.some((cardId) => effectiveCardColor(state, ownerId, cardId, skillIdsOf) === 'red')
    return owner?.alive && owner.characterId === MOU_XIAOQIAO.id && state.currentPlayerId === ownerId && state.phase === 'play'
      && used < 3 && canTarget && hasRedHand
      ? [{ id: `skill:${XQ_TIANXIANG}`, label: `天香：交给角色一张红色手牌并赋予其花色标记（${used}/3）` }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${XQ_TIANXIANG}`) return
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId
      && !(host.state as Batch54State).b54TianxiangMarks?.[player.id]).map((player) => player.id)
    if (!candidates.length) return
    host.askSkill({ skillId: XQ_TIANXIANG, ownerId, step: 'gift-target', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【天香】：选择一名没有“天香”标记的其他角色',
      timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.playerId !== ownerId || phase.phase !== 'prepare'
        || host.state.players.find((player) => player.id === ownerId)?.characterId !== MOU_XIAOQIAO.id) return
      const marks = markedTianxiang(host.state)
      if (!marks.length) return
      for (const { playerId } of marks) {
        delete (host.state as Batch54State).b54TianxiangMarks?.[playerId]
        const player = host.state.players.find((candidate) => candidate.id === playerId)
        if (player) delete player.marks['天香']
      }
      const drawn = drawCards(host.state, host.rng, ownerId, marks.length, (name, payload) => host.dispatch(name, payload))
      if (drawn.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: drawn, reason: XQ_TIANXIANG }, { targetId: ownerId, cardIds: drawn })
    } },
  ],
  offersTargetDamagePreventionAsk(host, ownerId) {
    if (host.state.players.find((player) => player.id === ownerId)?.characterId !== MOU_XIAOQIAO.id) return false
    const candidates = markedTianxiang(host.state).map(({ playerId }) => playerId)
    if (!candidates.length) return false
    host.askSkill({ skillId: XQ_TIANXIANG, ownerId, step: 'prevent', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【天香】：是否移除一名角色的“天香”标记发动其效果？',
      timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 0, max: 1,
    }) })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'resolve-mark') return
    const data = prompt.data as { targetId: PlayerId; suit: Suit; sourceId: PlayerId | null }
    const target = host.state.players.find((player) => player.id === data.targetId && player.alive)
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!target || !owner) return
    if (data.suit === 'heart') {
      if (data.sourceId && host.state.players.some((player) => player.id === data.sourceId && player.alive))
        resolveDamage(host as never, { sourceId: data.sourceId, targetId: target.id, amount: 1, nature: 'normal', cardName: '天香' })
      return
    }
    const pickable = pickableCardsOf(host.state, target.id, { includeJudgingArea: true })
    const total = pickable.cardIds.length + pickable.hiddenCardSlots.length
    if (!total) return
    host.askSkill({ skillId: XQ_TIANXIANG, ownerId, step: 'gift-cards', data: { targetId: target.id }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: target.id, prompt: '【天香】：交给小乔至多两张区域内的牌',
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots,
      min: Math.min(2, total), max: Math.min(2, total),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'gift-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive)
      if (!target || (host.state as Batch54State).b54TianxiangMarks?.[target.id]) return
      const cards = host.state.players.find((player) => player.id === ownerId)?.zones.hand.filter((cardId) => effectiveCardColor(host.state, ownerId, cardId, skillIdsOf) === 'red') ?? []
      if (!cards.length) return
      host.askSkill({ skillId: XQ_TIANXIANG, ownerId, step: 'gift-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【天香】：选择交给${target.nickname}的一张红色手牌`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'gift-card') {
      const targetId = resolution.data.targetId as PlayerId
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = host.state.players.find((player) => player.id === ownerId)
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      if (!owner?.alive || !target || !cardId || !owner.zones.hand.includes(cardId) || effectiveCardColor(host.state, ownerId, cardId, skillIdsOf) !== 'red') return
      const suit = effectiveCardSuit(host.state, ownerId, cardId, skillIdsOf)
      if (suit !== 'heart' && suit !== 'diamond') return
      const given = giveCards(host as never, ownerId, targetId, [cardId], XQ_TIANXIANG)
      if (!given.length) return
      const use = (host.state as Batch54State).b54TianxiangUses ??= {}
      const current = use[ownerId]?.turnNumber === host.state.turnNumber ? use[ownerId].count : 0
      use[ownerId] = { turnNumber: host.state.turnNumber, count: current + 1 }
      ;((host.state as Batch54State).b54TianxiangMarks ??= {})[targetId] = suit
      target.marks['天香'] = 1
      return
    }
    if (resolution.step === 'prevent') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const suit = targetId && (host.state as Batch54State).b54TianxiangMarks?.[targetId]
      if (!targetId || !suit) {
        resumeTargetDamagePrevention(host as never, false)
        return
      }
      delete (host.state as Batch54State).b54TianxiangMarks?.[targetId]
      const marked = host.state.players.find((player) => player.id === targetId)
      if (marked) delete marked.marks['天香']
      host.queueSkill({ skillId: XQ_TIANXIANG, ownerId, step: 'resolve-mark', data: {
        targetId, suit, sourceId: host.state.pendingTargetDamage?.options.sourceId ?? null,
      } })
      resumeTargetDamagePrevention(host as never, true, XQ_TIANXIANG)
      return
    }
    if (resolution.step === 'gift-cards') {
      const targetId = resolution.data.targetId as PlayerId
      const picked = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const cardIds = [...new Set(picked.map((value) => resolvePickedCard(host.state, targetId, value)).filter((id): id is CardId => Boolean(id)))].slice(0, 2)
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      const moved: CardId[] = []
      if (!target || !owner) return
      for (const cardId of cardIds) {
        const from = locateOwnedCard(host.state, targetId, cardId)
        if (!from) continue
        moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
        if (from.kind === 'equipment') handleEquipmentLost(host as never, targetId, cardId)
        moved.push(cardId)
      }
      if (moved.length) {
        host.dispatch('LoseCard', { playerId: targetId, cardIds: moved, reason: XQ_TIANXIANG }, { sourceId: targetId, targetId: ownerId, cardIds: moved })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: moved, reason: XQ_TIANXIANG }, { sourceId: targetId, targetId: ownerId, cardIds: moved })
      }
    }
  },
})

// 【御象】只在有护甲时启用双向距离修正与火焰易伤；官方技能文本没有“杀不可响应”效果。
registerSkillRuntime({ id: ML_YUXIANG,
  distanceModifier: {
    toOthers: (state, ownerId) => (state.players.find((player) => player.id === ownerId)?.armorPoints ?? 0) > 0 ? -1 : 0,
    fromOthers: (state, ownerId) => (state.players.find((player) => player.id === ownerId)?.armorPoints ?? 0) > 0 ? 1 : 0,
  },
  incomingDamage(state, ownerId, context) {
    return context.nature === 'fire'
      && (state.players.find((player) => player.id === ownerId)?.armorPoints ?? 0) > 0
      ? { amount: context.amount + 1 } : null
  },
})

const BEAST_OPTIONS: Array<{ id: BeastEffect; label: string }> = [
  { id: 'leopard', label: '豹：受到1点无来源伤害' },
  { id: 'eagle', label: '鹰：木鹿大王随机获得其一张牌' },
  { id: 'bear', label: '熊：随机弃置其装备区一张牌' },
  { id: 'rabbit', label: '兔：摸一张牌' },
]

function muluState(state: SanguoshaState, ownerId: PlayerId) {
  const mutable = state as Batch54State
  mutable.b54Mulu ??= {}
  return mutable.b54Mulu[ownerId] ??= { lastDealtTurn: -1, receivedCount: 0 }
}

function applyBeast(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, beast: BeastEffect): void {
  const target = host.state.players.find((candidate) => candidate.id === targetId)
  const owner = host.state.players.find((candidate) => candidate.id === ownerId)
  if (!target?.alive || !owner?.alive) return
  if (beast === 'leopard') {
    resolveDamage(host as never, { sourceId: null, targetId, amount: 1, nature: 'normal' })
    return
  }
  if (beast === 'eagle') {
    const cards = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)), ...target.zones.judgingArea]
    if (!cards.length) return
    const cardId = host.rng.pick(cards)
    const from = locateOwnedCard(host.state, targetId, cardId)
    if (!from) return
    moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: ML_SHOUFA }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ML_SHOUFA }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
    return
  }
  if (beast === 'bear') {
    const equipment = Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))
    if (!equipment.length) return
    const cardId = host.rng.pick(equipment)
    const from = locateOwnedCard(host.state, targetId, cardId)
    if (!from) return
    moveCard(host.state, cardId, from, { kind: 'discardPile' }, { discardReason: 'discard' })
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: ML_SHOUFA }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    return
  }
  const drawn = drawCards(host.state, host.rng, targetId, 1)
  if (drawn.length) host.dispatch('GainCard', { playerId: targetId, cardIds: drawn, reason: ML_SHOUFA }, { targetId, cardIds: drawn })
}

function askMuluTarget(host: SkillHost, ownerId: PlayerId, cause: 'dealt' | 'received', turnNumber: number): void {
  const candidates = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId
    && (cause === 'dealt' ? getDistance(host.state, ownerId, candidate.id) <= 2 : getDistance(host.state, ownerId, candidate.id) > 2))
  if (!candidates.length) return
  host.askSkill({ skillId: ML_SHOUFA, ownerId, step: 'target', data: { cause, turnNumber }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId,
    prompt: `【兽法】：选择一名距离${cause === 'dealt' ? '2以内' : '大于2'}的其他角色，其执行野兽效果`,
    timeoutMs: 25_000, optional: true, candidateIds: candidates.map((candidate) => candidate.id), min: 1, max: 1,
  }) })
}

registerSkillRuntime({ id: ML_ZHOULIN, limited: true,
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    if (!owner?.alive || owner.characterId !== MULUDAWANG.id || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || owner.usedLimitedSkills.includes(ML_ZHOULIN)) return []
    return [{ id: `skill:${ML_ZHOULIN}`, label: '咒鳞：获得2点护甲并指定兽法效果' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${ML_ZHOULIN}`) return
    const owner = host.state.players.find((player) => player.id === ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(ML_ZHOULIN)) return
    owner.usedLimitedSkills.push(ML_ZHOULIN)
    gainArmor(host as never, ownerId, 2, ML_ZHOULIN)
    host.askSkill({ skillId: ML_ZHOULIN, ownerId, step: 'choose-beast', build: (id) => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【咒鳞】：选择一种兽法效果，直到你下回合开始时固定触发',
      timeoutMs: 30_000, optional: false, options: BEAST_OPTIONS,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-beast') return
    const beast = (response.payload as { optionId?: string }).optionId as BeastEffect | undefined
    if (!BEAST_OPTIONS.some((option) => option.id === beast)) return
    const entry = muluState(host.state, ownerId)
    entry.forcedBeast = beast
    entry.forcedUntilTurn = host.state.turnNumber
  },
})

registerSkillRuntime({ id: ML_SHOUFA,
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const state = muluState(host.state, ownerId)
      if (state.lastDealtTurn === host.state.turnNumber) return
      state.lastDealtTurn = host.state.turnNumber
      host.queueSkill({ skillId: ML_SHOUFA, ownerId, step: 'dealt', data: { turnNumber: host.state.turnNumber } })
    } },
    { event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const state = muluState(host.state, ownerId)
      if (state.receivedCount >= 5) return
      state.receivedCount += 1
      host.queueSkill({ skillId: ML_SHOUFA, ownerId, step: 'received', data: { turnNumber: host.state.turnNumber } })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const state = muluState(host.state, ownerId)
      state.receivedCount = 0
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId && state.forcedUntilTurn !== undefined) {
        delete state.forcedBeast
        delete state.forcedUntilTurn
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (!host.state.players.find((player) => player.id === ownerId)?.alive) return
    askMuluTarget(host, ownerId, prompt.step === 'dealt' ? 'dealt' : 'received', Number(prompt.data.turnNumber))
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? host.state.players.find((player) => player.id === targetId) : undefined
    if (!target?.alive || !host.state.players.find((player) => player.id === ownerId)?.alive) return
    const cause = resolution.data.cause as 'dealt' | 'received'
    const withinRange = getDistance(host.state, ownerId, targetId!) <= 2
    if ((cause === 'dealt') !== withinRange) return
    const state = muluState(host.state, ownerId)
    const forced = state.forcedBeast
    applyBeast(host, ownerId, targetId!, forced ?? host.rng.pick(['leopard', 'eagle', 'bear', 'rabbit'] as const))
  },
})

function xiahouState(state: SanguoshaState, ownerId: PlayerId) {
  const mutable = state as Batch54State
  mutable.b54Xiahou ??= {}
  return mutable.b54Xiahou[ownerId] ??= { damagedBy: [], usedAgainst: [] }
}

registerSkillRuntime({ id: XD_GANGLIE,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || !context.event.sourceId || context.event.sourceId === ownerId) return
    const entry = xiahouState(host.state, ownerId)
    if (!entry.damagedBy.includes(context.event.sourceId)) entry.damagedBy.push(context.event.sourceId)
  } }],
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    if (!owner?.alive || owner.characterId !== MOU_XIAHOU_DUN.id || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, XD_GANGLIE)) return []
    const eligible = xiahouState(state, ownerId).damagedBy.filter((id) => !xiahouState(state, ownerId).usedAgainst.includes(id)
      && state.players.some((player) => player.id === id && player.alive))
    return eligible.length ? [{ id: `skill:${XD_GANGLIE}`, label: '刚烈：对本局曾伤害过你的角色造成2点伤害' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${XD_GANGLIE}` || usedThisPhase(host.state, ownerId, XD_GANGLIE)) return
    const entry = xiahouState(host.state, ownerId)
    const candidates = entry.damagedBy.filter((id) => !entry.usedAgainst.includes(id)
      && host.state.players.some((player) => player.id === id && player.alive))
    if (!candidates.length) return
    markUsedThisPhase(host.state, ownerId, XD_GANGLIE)
    host.askSkill({ skillId: XD_GANGLIE, ownerId, step: 'targets', data: { candidateIds: candidates }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【刚烈】：选择本局曾对你造成过伤害且未被此技能指定过的角色',
      timeoutMs: 30_000, optional: false, candidateIds: candidates, min: 1, max: candidates.length,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'targets') return
    const owner = host.state.players.find((player) => player.id === ownerId)
    if (!owner?.alive) return
    const selected = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
    const entry = xiahouState(host.state, ownerId)
    const allowed = new Set(resolution.data.candidateIds as PlayerId[])
    const targets = selected.filter((id) => allowed.has(id) && entry.damagedBy.includes(id)
      && !entry.usedAgainst.includes(id) && host.state.players.some((player) => player.id === id && player.alive))
    if (!targets.length) return
    entry.usedAgainst.push(...targets)
    resolveDamageSequence(host as never, { sourceId: ownerId, targetIds: targets, amount: 2, nature: 'normal', cardId: null, cardName: '刚烈' })
  },
})

registerSkillRuntime({ id: XD_QINGJIAN,
  triggers: [
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; fromKind?: string; reason?: string }
      const cardId = payload.cardId
      const owner = host.state.players.find((player) => player.id === ownerId)
      if (!owner?.alive || !cardId || (payload.fromKind === 'processing' && payload.reason === 'other')) return
      const pile = owner.characterPiles[XD_QINGJIAN] ?? (owner.characterPiles[XD_QINGJIAN] = [])
      const capacity = Math.max(1, owner.hp - 1)
      if (pile.length >= capacity || !host.state.zones.discardPile.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: XD_QINGJIAN })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'play') return
      const owner = host.state.players.find((player) => player.id === ownerId)
      const cardIds = owner?.characterPiles[XD_QINGJIAN] ?? []
      const recipients = host.state.players.filter((player) => player.alive).map((player) => player.id)
      if (!owner?.alive || !cardIds.length || !recipients.length) return
      host.askSkill({ skillId: XD_QINGJIAN, ownerId, step: 'distribute', data: { cardIds: [...cardIds] }, build: (id): DistributeCardsRequest => ({
        id, kind: 'distribute-cards', playerId: ownerId, prompt: '【清俭】：将“清俭”牌分配给任意角色',
        timeoutMs: 30_000, optional: false, cardIds: [...cardIds], recipientIds: recipients, min: cardIds.length, max: cardIds.length,
      }) })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'distribute') return
    const owner = host.state.players.find((player) => player.id === ownerId)
    if (!owner?.alive) return
    const assignments = (response.payload as { assignments?: Array<{ cardId?: CardId; recipientId?: PlayerId }> }).assignments ?? []
    const original = new Set(resolution.data.cardIds as CardId[])
    const moved = new Map<PlayerId, CardId[]>()
    for (const assignment of assignments) {
      const cardId = assignment.cardId
      const recipientId = assignment.recipientId
      const recipient = recipientId && host.state.players.find((player) => player.id === recipientId && player.alive)
      if (!cardId || !recipient || !original.has(cardId) || !owner.characterPiles[XD_QINGJIAN]?.includes(cardId)) continue
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: XD_QINGJIAN }, { kind: 'hand', playerId: recipient.id })
      const cards = moved.get(recipient.id) ?? []
      cards.push(cardId)
      moved.set(recipient.id, cards)
    }
    for (const [recipientId, cardIds] of moved)
      host.dispatch('GainCard', { playerId: recipientId, cardIds, reason: XD_QINGJIAN }, { sourceId: ownerId, targetId: recipientId, cardIds })
  },
})

registerSkillRuntime({ id: HD_GONGQI,
  attackRangeBonus(state, ownerId) {
    return state.players.some((player) => player.id === ownerId && player.characterId === MOU_HANDANG.id) ? 4 : 0
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = host.state.players.find((player) => player.id === ownerId)
      if (!owner?.alive || owner.characterId !== MOU_HANDANG.id || phase.playerId !== ownerId || phase.phase !== 'play') return
      const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
        .filter((cardId) => !isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId))
      if (!cards.length) return
      host.askSkill({ skillId: HD_GONGQI, ownerId, step: 'discard', data: { turnNumber: host.state.turnNumber }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【弓骑】：可弃置一张牌；若如此做，本阶段他人响应你使用的牌受颜色限制',
        timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 0, max: 1,
      }) })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.playerId === ownerId && phase.phase === 'play') delete (host.state as Batch54State).b54Gongqi?.[ownerId]
    } },
  ],
  prohibitsResponseCard(state, ownerId, responderId, responseCardId) {
    if (responderId === ownerId) return false
    const restriction = (state as Batch54State).b54Gongqi?.[ownerId]
    if (!restriction || restriction.turnNumber !== state.turnNumber || state.phase !== 'play' || state.currentPlayerId !== ownerId) return false
    const card = state.cards[responseCardId]
    if (card?.virtual) return false
    const from = locateOwnedCard(state, responderId, responseCardId)
    if (from?.kind !== 'hand') return true
    return effectiveCardColor(state, responderId, responseCardId) !== restriction.color
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const cardId = selected[0]
    const owner = host.state.players.find((player) => player.id === ownerId)
    if (!cardId || selected.length !== 1 || !owner?.alive || resolution.data.turnNumber !== host.state.turnNumber) return
    const from = locateOwnedCard(host.state, ownerId, cardId)
    if (!from || isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId)) return
    const color = effectiveCardColor(host.state, ownerId, cardId)
    if (color !== 'red' && color !== 'black') return
    moveCard(host.state, cardId, from, { kind: 'discardPile' }, { discardReason: 'discard' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: HD_GONGQI }, { sourceId: ownerId, cardIds: [cardId] })
    const state = host.state as Batch54State
    state.b54Gongqi ??= {}
    state.b54Gongqi[ownerId] = { turnNumber: host.state.turnNumber, color }
  },
})

// 【缓释】：由诸葛瑾提供改判牌，但把选择请求交给正在判定的角色。
// 改判牌仍由公共判定管线移入处理区并结算，避免技能自搬牌造成判定牌滞留。
registerSkillRuntime({ id: ZJ_HUANSHI,
  retrial(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    return owner?.alive ? [...owner.zones.hand] : []
  },
  retrialDrawPileTop(state, ownerId) {
    return state.players.some((player) => player.id === ownerId && player.alive) && state.zones.drawPile.length > 0
  },
  retrialDecidedBy(_state, _ownerId, judgingPlayerId) { return judgingPlayerId },
})

function recordLuxunLoss(state: SanguoshaState, ownerId: PlayerId, cardIds: readonly CardId[]): void {
  const mutable = state as Batch54State
  mutable.b54LuxunLoss ??= {}
  const current = mutable.b54LuxunLoss[ownerId]
  const entry = current?.turnNumber === state.turnNumber ? current : { turnNumber: state.turnNumber, cardIds: [] }
  for (const cardId of cardIds) if (!entry.cardIds.includes(cardId)) entry.cardIds.push(cardId)
  mutable.b54LuxunLoss[ownerId] = entry
}

// 【连营】：按本回合实际离开陆逊区域的实体牌去重；使用/响应和 LoseCard 可能
// 指向同一张牌，不能重复计算。回合结束时以私有请求查看牌堆顶并分配全部牌。
registerSkillRuntime({ id: LX_LIANYING,
  triggers: [
    { event: 'TurnStart', handle(host) {
      const state = host.state as Batch54State
      state.b54LuxunLoss ??= {}
      for (const player of host.state.players) state.b54LuxunLoss[player.id] = { turnNumber: host.state.turnNumber, cardIds: [] }
    } },
    { event: 'LoseCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId === ownerId) recordLuxunLoss(host.state, ownerId, payload.cardIds ?? [])
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[]; fromKind?: string }
      if (payload.fromKind === 'hand' || payload.fromKind === 'equipment')
        recordLuxunLoss(host.state, ownerId, payload.cardIds ?? (payload.cardId ? [payload.cardId] : []))
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId; fromKind?: string }
      if (payload.playerId === ownerId && (payload.fromKind === 'hand' || payload.fromKind === 'equipment') && payload.cardId)
        recordLuxunLoss(host.state, ownerId, [payload.cardId])
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const turn = context.event.payload as { playerId?: PlayerId }
      if (turn.playerId === ownerId || !host.state.players.some((player) => player.id === ownerId && player.alive)) return
      const entry = (host.state as Batch54State).b54LuxunLoss?.[ownerId]
      const count = entry?.turnNumber === host.state.turnNumber ? entry.cardIds.length : 0
      const top = host.state.zones.drawPile.slice(0, Math.min(5, count))
      const recipients = host.state.players.filter((player) => player.alive).map((player) => player.id)
      if (!top.length || !recipients.length) return
      host.askSkill({ skillId: LX_LIANYING, ownerId, step: 'invoke', data: { cardIds: top }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【连营】：是否观看牌堆顶${top.length}张牌并分配给任意角色？`,
        timeoutMs: 25_000, optional: false, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }) })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const cardIds = (resolution.data.cardIds as CardId[]).filter((id) => host.state.zones.drawPile.includes(id))
      const recipients = host.state.players.filter((player) => player.alive).map((player) => player.id)
      if (!cardIds.length || !recipients.length) return
      host.askSkill({ skillId: LX_LIANYING, ownerId, step: 'distribute', data: { cardIds }, build: (id): DistributeCardsRequest => ({
        id, kind: 'distribute-cards', playerId: ownerId, prompt: '【连营】：观看牌堆顶并将这些牌分配给任意角色',
        timeoutMs: 30_000, optional: false, cardIds, recipientIds: recipients, min: cardIds.length, max: cardIds.length,
      }) })
      return
    }
    if (resolution.step !== 'distribute') return
    const assignments = (response.payload as { assignments?: Array<{ cardId?: CardId; recipientId?: PlayerId }> }).assignments ?? []
    const original = new Set(resolution.data.cardIds as CardId[])
    for (const item of assignments) {
      const cardId = item.cardId
      const recipientId = item.recipientId
      const recipient = recipientId && host.state.players.find((player) => player.id === recipientId && player.alive)
      if (!cardId || !recipient || !original.has(cardId) || !host.state.zones.drawPile.includes(cardId)) continue
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: recipient.id })
      host.dispatch('GainCard', { playerId: recipient.id, cardIds: [cardId], reason: LX_LIANYING }, { sourceId: ownerId, targetId: recipient.id, cardIds: [cardId] })
    }
  },
})

function removeVirtualTrick(host: SkillHost, ownerId: PlayerId, cardId: CardId): void {
  const owner = host.state.players.find((player) => player.id === ownerId)
  if (owner) owner.zones.hand = owner.zones.hand.filter((id) => id !== cardId)
  delete host.state.cards[cardId]
}

registerSkillRuntime({ id: LX_QIANXUN,
  triggers: [
    { event: 'CardResolved', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[]; cancelled?: boolean }
      if (payload.cancelled || context.event.sourceId === ownerId || !payload.cardName || !payload.targetIds?.includes(ownerId)) return
      const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
      if (card?.category !== 'trick') return
      const state = host.state as Batch54State
      state.b54LuxunNames ??= {}
      const names = state.b54LuxunNames[ownerId] ?? (state.b54LuxunNames[ownerId] = [])
      if (names.includes(payload.cardName) || names.length >= 5) return
      names.push(payload.cardName)
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner) return
      const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      const max = Math.min(5, names.length, cardIds.length)
      if (max <= 0) return
      host.queueSkill({ skillId: LX_QIANXUN, ownerId, step: 'store', data: { max, turnNumber: host.state.turnNumber } })
    } },
    { event: 'TurnEnd', handle(host, ownerId) {
      const state = host.state as Batch54State
      if (state.b54LuxunReturnTurn?.[ownerId] !== host.state.turnNumber) return
      const owner = host.state.players.find((player) => player.id === ownerId)
      if (!owner?.alive) return
      const pile = owner.characterPiles[LX_QIANXUN] ?? []
      const cardIds = [...pile]
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: LX_QIANXUN }, { kind: 'hand', playerId: ownerId })
      if (cardIds.length) host.dispatch('GainCard', { playerId: ownerId, cardIds, reason: LX_QIANXUN }, { targetId: ownerId, cardIds })
      delete state.b54LuxunReturnTurn[ownerId]
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner || owner.characterId !== MOU_LUXUN.id || phase.playerId !== ownerId || phase.phase !== 'play') return
      const names = (host.state as Batch54State).b54LuxunNames?.[ownerId] ?? []
      if (!names.length) return
      host.askSkill({ skillId: LX_QIANXUN, ownerId, step: 'remove-name', data: { names: [...names] }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【谦逊】：移去一个记录的锦囊牌名；若为普通锦囊，可视为使用之',
        timeoutMs: 25_000, optional: true, options: [{ id: 'skip', label: '不发动' }, ...names.map((name) => ({ id: name, label: `移去【${name}】` }))],
      }) })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'store') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner) return
    const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    if (!cardIds.length) return
    const max = Math.min(Number(prompt.data.max), cardIds.length)
    if (max <= 0) return
    host.askSkill({ skillId: LX_QIANXUN, ownerId, step: 'store-cards', data: { turnNumber: prompt.data.turnNumber }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【谦逊】：可将至多${max}张手牌或装备牌置于武将牌上`,
      timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as Batch54State
    if (resolution.step === 'store-cards') {
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner || resolution.data.turnNumber !== host.state.turnNumber) return
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].slice(0, 5)
      const allowed = new Set([...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))])
      const moved: CardId[] = []
      for (const cardId of selected) {
        if (!allowed.has(cardId)) continue
        const from = locateOwnedCard(host.state, ownerId, cardId)
        if (!from || (from.kind !== 'hand' && from.kind !== 'equipment')) continue
        moveCard(host.state, cardId, from, { kind: 'characterPile', playerId: ownerId, pile: LX_QIANXUN })
        if (from.kind === 'equipment') handleEquipmentLost(host as never, ownerId, cardId)
        moved.push(cardId)
      }
      if (moved.length) {
        state.b54LuxunReturnTurn ??= {}
        state.b54LuxunReturnTurn[ownerId] = host.state.turnNumber
      }
      return
    }
    if (resolution.step === 'remove-name') {
      const name = (response.payload as { optionId?: string }).optionId
      if (!name || name === 'skip') return
      const names = state.b54LuxunNames?.[ownerId] ?? []
      if (!(resolution.data.names as string[]).includes(name) || !names.includes(name)) return
      state.b54LuxunNames![ownerId] = names.filter((item) => item !== name)
      if (!INSTANT_TRICKS.has(name) || !virtualTrickChoices(host.state, ownerId).includes(name)) return
      const cardId = createVirtualTrick(host.state, ownerId, name, LX_QIANXUN)
      const [action] = instantTrickActions(host.state, ownerId, cardId, name)
      if (!action || action.kind !== 'use-card') { removeVirtualTrick(host, ownerId, cardId); return }
      if (action.targetMode === 'fixed' || action.targetMax === 0) {
        executeUseCardAction(host as never, ownerId, action)
        return
      }
      host.askSkill({ skillId: LX_QIANXUN, ownerId, step: 'use-trick-targets', data: { cardId, name }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: `【谦逊】：为【${name}】选择合法目标`,
        timeoutMs: 25_000, optional: false, candidateIds: action.targetIds, min: action.targetMin, max: action.targetMax,
      }) })
      return
    }
    if (resolution.step === 'use-trick-targets') {
      const cardId = resolution.data.cardId as CardId
      const name = resolution.data.name as string
      const targets = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const [action] = instantTrickActions(host.state, ownerId, cardId, name)
      if (!action || action.kind !== 'use-card' || !targets.length || targets.some((id) => !action.targetIds.includes(id))) {
        removeVirtualTrick(host, ownerId, cardId)
        return
      }
      executeUseCardAction(host as never, ownerId, { ...action, targetIds: targets })
    }
  },
})

function jiefanRangeHolders(state: SanguoshaState, targetId: PlayerId): PlayerId[] {
  const referenceSeat = state.players.find((player) => player.id === state.currentPlayerId)?.seat ?? 0
  return state.players.filter((player) => player.alive && player.id !== targetId
    && getDistance(state, player.id, targetId) <= getAttackRange(state, player.id))
    .sort((left, right) => ((left.seat - referenceSeat + state.players.length) % state.players.length)
      - ((right.seat - referenceSeat + state.players.length) % state.players.length))
    .map((player) => player.id)
}

function askNextJiefanDiscard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, candidates: PlayerId[], index: number, drawCount: number): void {
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
  if (!owner) return
  let nextIndex = index
  while (nextIndex < candidates.length) {
    const discarderId = candidates[nextIndex]
    const discarder = host.state.players.find((player) => player.id === discarderId && player.alive)
    if (!discarder) { nextIndex += 1; continue }
    const pickable = pickableCardsOf(host.state, discarderId, { discarderId })
    if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) { nextIndex += 1; continue }
    host.askSkill({ skillId: HD_JIEFAN, ownerId, step: 'discard-range-holder', data: { targetId, candidates, index: nextIndex, drawCount }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: discarderId, prompt: '【解烦】：弃置你的一张手牌或装备牌',
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
    }) })
    return
  }
  finishJiefanDiscard(host, ownerId, targetId, candidates, nextIndex, drawCount)
}

function discardForJiefan(host: SkillHost, discarderId: PlayerId, picked: string, sourceId: PlayerId): void {
  const cardId = resolvePickedCard(host.state, discarderId, picked)
  if (!cardId) return
  const from = locateOwnedCard(host.state, discarderId, cardId)
  if (!from || (from.kind !== 'hand' && from.kind !== 'equipment') || isCardProtectedFromDiscard(host.state, discarderId, cardId, discarderId)) return
  moveCard(host.state, cardId, from, { kind: 'discardPile' }, { discardReason: 'discard' })
  if (from.kind === 'equipment') handleEquipmentLost(host as never, discarderId, cardId)
  host.dispatch('LoseCard', { playerId: discarderId, cardIds: [cardId], reason: HD_JIEFAN }, { sourceId, targetId: discarderId, cardIds: [cardId] })
}

function finishJiefanDiscard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, candidates: PlayerId[], index: number, drawCount: number): void {
  if (index < candidates.length) { askNextJiefanDiscard(host, ownerId, targetId, candidates, index, drawCount); return }
  const target = host.state.players.find((player) => player.id === targetId && player.alive)
  if (!target || drawCount <= 0) return
  const cards = drawCards(host.state, host.rng, targetId, drawCount, (name, payload) => host.dispatch(name, payload))
  if (cards.length) host.dispatch('GainCard', { playerId: targetId, cardIds: cards, reason: HD_JIEFAN }, { sourceId: ownerId, targetId, cardIds: cards })
}

registerSkillRuntime({ id: HD_JIEFAN,
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    const disabled = (state as Batch54State).b54JiefanDisabled?.includes(ownerId)
    return owner?.alive && owner.characterId === MOU_HANDANG.id && !owner.characterSkillsDisabled
      && !disabled && state.currentPlayerId === ownerId && state.phase === 'play' && !usedThisPhase(state, ownerId, HD_JIEFAN)
      ? [{ id: `skill:${HD_JIEFAN}`, label: '解烦：指定一名角色' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${HD_JIEFAN}`) return
    const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
    if (!targets.length) return
    host.askSkill({ skillId: HD_JIEFAN, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【解烦】：选择一名角色', timeoutMs: 25_000,
      optional: false, candidateIds: targets, min: 1, max: 1,
    }) })
  },
  triggers: [{ event: 'Death', handle(host, ownerId, context) {
    const death = context.event.payload as { sourceId?: PlayerId; playerId?: PlayerId }
    if (death.sourceId !== ownerId) return
    const state = host.state as Batch54State
    state.b54JiefanDisabled = (state.b54JiefanDisabled ?? []).filter((id) => id !== ownerId)
  } }],
  resume(host, ownerId, resolution, response) {
    const state = host.state as Batch54State
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !host.state.players.some((player) => player.id === targetId && player.alive && player.id !== ownerId)) return
      markUsedThisPhase(host.state, ownerId, HD_JIEFAN)
      const holders = jiefanRangeHolders(host.state, targetId)
      host.askSkill({ skillId: HD_JIEFAN, ownerId, step: 'mode', data: { targetId, holderIds: holders }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: targetId, prompt: '【解烦】：选择一项；背水需同时执行两项并令此技能失效直至你杀死一名角色',
        timeoutMs: 25_000, optional: false, options: [
          { id: 'discard', label: `令攻击范围包含目标的${holders.length}名角色依次弃置一张牌` },
          { id: 'draw', label: `令目标摸${holders.length}张牌` },
          { id: 'backwater', label: '背水：执行以上两项，然后此技能失效直至你杀死一名角色' },
        ],
      }) })
      return
    }
    if (resolution.step === 'mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      const targetId = resolution.data.targetId as PlayerId
      const holders = (resolution.data.holderIds as PlayerId[]).filter((id) => host.state.players.some((player) => player.id === id && player.alive))
      if (!['discard', 'draw', 'backwater'].includes(mode ?? '') || !host.state.players.some((player) => player.id === targetId && player.alive)) return
      if (mode === 'backwater') {
        state.b54JiefanDisabled = [...new Set([...(state.b54JiefanDisabled ?? []), ownerId])]
        askNextJiefanDiscard(host, ownerId, targetId, holders, 0, holders.length)
      } else if (mode === 'discard') askNextJiefanDiscard(host, ownerId, targetId, holders, 0, 0)
      else finishJiefanDiscard(host, ownerId, targetId, holders, holders.length, holders.length)
      return
    }
    if (resolution.step !== 'discard-range-holder') return
    const targetId = resolution.data.targetId as PlayerId
    const candidates = resolution.data.candidates as PlayerId[]
    const index = resolution.data.index as number
    const discardId = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const discardSlot = (response.payload as { hiddenCardSlots?: string[] }).hiddenCardSlots?.[0]
    const selected = discardId ?? discardSlot
    if (selected) discardForJiefan(host, response.playerId, selected, ownerId)
    finishJiefanDiscard(host, ownerId, targetId, candidates, index + 1, Number(resolution.data.drawCount ?? 0))
  },
})

// 【乱武】：限定技，逐名角色在当前合法距离最近的其他角色中选择一名出杀；
// 无合法目标或未能使用时由统一失去体力入口结算，防止直接改 hp 漏掉濒死。
registerSkillRuntime({ id: skill('luanwu-mou-jiaxu'), limited: true,
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId)
    const used = (state as Batch54State).b54LuanwuUsed?.includes(ownerId)
    return owner?.alive && owner.characterId === MOU_JIA_XU.id && !owner.characterSkillsDisabled
      && state.currentPlayerId === ownerId && state.phase === 'play' && !used
      ? [{ id: `skill:${skill('luanwu-mou-jiaxu')}`, label: '乱武：令所有其他角色依次使用【杀】' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${skill('luanwu-mou-jiaxu')}`) return
    const state = host.state as Batch54State
    state.b54LuanwuUsed = [...new Set([...(state.b54LuanwuUsed ?? []), ownerId])]
    const ownerSeat = host.state.players.find((player) => player.id === ownerId)?.seat ?? 0
    const actors = host.state.players.filter((player) => player.alive && player.id !== ownerId)
      .sort((a, b) => ((a.seat - ownerSeat + host.state.players.length) % host.state.players.length)
        - ((b.seat - ownerSeat + host.state.players.length) % host.state.players.length))
      .map((player) => player.id)
    host.queueSkill({ skillId: skill('luanwu-mou-jiaxu'), ownerId, step: 'next-actor', data: { actors, index: 0 } })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'next-actor') resolveNextLuanwu(host, ownerId, prompt.data.actors as PlayerId[], Number(prompt.data.index))
    if (prompt.step === 'upgrade-choice') {
      const state = host.state as Batch54State
      state.b54JiaXuUpgrades ??= {}
      const levels = state.b54JiaXuUpgrades[ownerId] ??= { wansha: 1, weimu: 1 }
      const options = [
        ...(levels.wansha < 2 ? [{ id: 'wansha', label: '升级【完杀】' }] : []),
        ...(levels.weimu < 2 ? [{ id: 'weimu', label: '升级【帷幕】' }] : []),
        { id: 'skip', label: '不升级' },
      ]
      host.askSkill({ skillId: skill('luanwu-mou-jiaxu'), ownerId, step: 'upgrade-choice', build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【乱武】：有角色因此失去体力，你可以升级一项技能',
        timeoutMs: 25_000, optional: false, options,
      }) })
    }
  },
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    const payload = context.event.payload as { sourceSkillId?: string }
    const state = host.state as Batch54State
    const progress = state.b54LuanwuProgress?.[ownerId]
    if (!progress || payload.sourceSkillId !== skill('luanwu-mou-jiaxu') || context.event.sourceId !== progress.waitingForActor) return
    delete state.b54LuanwuProgress?.[ownerId]
    host.queueSkill({ skillId: skill('luanwu-mou-jiaxu'), ownerId, step: 'next-actor', data: { actors: progress.actors, index: progress.nextIndex } })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'upgrade-choice') {
      const state = host.state as Batch54State
      state.b54JiaXuUpgrades ??= {}
      const levels = state.b54JiaXuUpgrades[ownerId] ??= { wansha: 1, weimu: 1 }
      const option = (response.payload as { optionId?: string }).optionId
      if (option === 'wansha') levels.wansha = Math.min(2, levels.wansha + 1)
      if (option === 'weimu') levels.weimu = Math.min(2, levels.weimu + 1)
      return
    }
    if (resolution.step !== 'actor-target') return
    const actorId = resolution.data.actorId as PlayerId
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const nearestIds = resolution.data.nearestIds as PlayerId[]
    const valid = targetId && nearestIds.includes(targetId)
      && host.state.players.some((player) => player.id === actorId && player.alive)
      && host.state.players.some((player) => player.id === targetId && player.alive)
      && !isTargetProhibited(host.state, actorId, targetId, '杀', skillIdsOf)
    const state = host.state as Batch54State
    if (valid) {
      state.b54LuanwuProgress ??= {}
      state.b54LuanwuProgress[ownerId] = {
        actors: resolution.data.actors as PlayerId[], nextIndex: Number(resolution.data.nextIndex), waitingForActor: actorId,
      }
    }
    const used = valid && host.beginVirtualSlash({ sourceId: actorId, targetId, sourceSkillId: skill('luanwu-mou-jiaxu'), countUsage: true })
    if (!used && valid) delete state.b54LuanwuProgress?.[ownerId]
    if (!used && host.state.players.some((player) => player.id === actorId && player.alive)) {
      loseHp(host as never, actorId, 1, skill('luanwu-mou-jiaxu'))
      host.queueSkill({ skillId: skill('luanwu-mou-jiaxu'), ownerId, step: 'upgrade-choice', data: {} })
      host.queueSkill({ skillId: skill('luanwu-mou-jiaxu'), ownerId, step: 'next-actor', data: { actors: resolution.data.actors, index: resolution.data.nextIndex } })
    }
  },
})

function resolveNextLuanwu(host: SkillHost, ownerId: PlayerId, actors: PlayerId[], index: number): void {
  if (index >= actors.length) return
  const actorId = actors[index]
  const actor = host.state.players.find((player) => player.id === actorId && player.alive)
  if (!actor) { resolveNextLuanwu(host, ownerId, actors, index + 1); return }
  const candidates = host.state.players.filter((target) => target.alive && target.id !== actorId)
  if (!candidates.length) {
    loseHp(host as never, actorId, 1, skill('luanwu-mou-jiaxu'))
    host.queueSkill({ skillId: skill('luanwu-mou-jiaxu'), ownerId, step: 'upgrade-choice', data: {} })
    host.queueSkill({ skillId: skill('luanwu-mou-jiaxu'), ownerId, step: 'next-actor', data: { actors, index: index + 1 } })
    return
  }
  const nearest = Math.min(...candidates.map((target) => getDistance(host.state, actorId, target.id)))
  const nearestIds = candidates.filter((target) => getDistance(host.state, actorId, target.id) === nearest).map((target) => target.id)
  host.askSkill({ skillId: skill('luanwu-mou-jiaxu'), ownerId, step: 'actor-target', data: { actorId, actors, nextIndex: index + 1, nearestIds }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: actorId, prompt: '【乱武】：你须对距离最近的一名其他角色使用【杀】',
    timeoutMs: 25_000, optional: false, candidateIds: nearestIds, min: 1, max: 1,
  }) })
}

//


