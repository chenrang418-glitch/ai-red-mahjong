import type { CharacterDefinition } from './types'
import { executeUseCardAction } from '../../engine/cards/basic'
import type { LegalAction } from '../../engine/actions'
import { drawCards, revealTopCards } from '../../engine/draw'
import { gainArmor } from '../../engine/armor'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { finalizeDamage, forceDeath, resolveDamage, resolveDamageSequence } from '../../engine/damage'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { beginJudgmentRetention, endJudgmentRetention, retainedJudgmentCards, retainedJudgmentSuits } from '../../engine/judgment-retention'
import { detainCards } from '../../engine/turn-bound-pile'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { giveCards } from '../../engine/hand-transfer'
import { registerGroupDecision, startGroupDecision, type GroupDecisionHost } from '../../engine/group-decision'
import { schedulePhaseSkipForPlayer } from '../../engine/turn'
import { effectiveCardColor, effectiveCardSuit, grantSkill, isCardProtectedFromDiscard, registerSkillRuntime, type SkillHost, type ViewAsOption } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { canTarget } from '../../engine/distance'
import { effectiveKingdomOf } from '../../engine/huashen'
import { finishMission, missionInProgress } from '../../engine/mission-skill'
import { canPindian, registerPindianContinuation, startPindian } from '../../engine/pindian'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, DamageNature, GroupDecisionState, PlayerId, SanguoshaState, TurnPhase } from '../../engine/types'

const S53 = ':b53'
const sid = (id: string) => `${id}${S53}`

const MOU_FAZHENG: CharacterDefinition = {
  id: 'mou-fazheng-b53', name: '谋·法正', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: sid('xuanhuo-mou-fazheng'), name: '眩惑', description: '出牌阶段限一次，你可以交给一名没有“眩”标记的其他角色一张牌并令其获得“眩”标记。有“眩”标记的角色于摸牌阶段外获得牌时，你随机获得其一张手牌（每个“眩”标记最多令你获得五张牌）。' },
    { id: sid('enyuan-mou-fazheng'), name: '恩怨', description: '锁定技，准备阶段，你令有“眩”标记的角色执行以下效果：自其获得“眩”标记开始，若你获得其至少三张牌，则你移除其“眩”标记，然后交给其三张牌；否则其流失1点体力值，然后你回复1点体力并移除其“眩”标记。' },
  ],
}
const MOU_CHENGONG: CharacterDefinition = {
  id: 'mou-chengong-b53', name: '谋·陈宫', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: sid('mingce-mou-chengong'), name: '明策', description: '出牌阶段限一次，你可以将一张牌交给一名其他角色，然后其选择一项：1.其流失1点体力，你摸两张牌并获得一个“策”标记；2.其摸一张牌。出牌阶段开始时，若你拥有“策”标记，你可以选择一名其他角色，对其造成X点伤害并移除所有“策”标记（X为你拥有的“策”标记数量）。' },
    { id: sid('zhichi-mou-chengong'), name: '智迟', description: '锁定技，当你受到伤害后，本回合接下来你受到伤害时，防止之。' },
  ],
}
const MOU_GANNING: CharacterDefinition = {
  id: 'mou-ganning-b53', name: '谋·甘宁', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: sid('qixi-mou-ganning'), name: '奇袭', description: '出牌阶段限一次，你可以选择一名其他角色，令其猜测你手牌中某种花色的牌最多（或之一）。若其猜错，你可令其再次猜测（其无法选择此阶段已猜测过的花色）；否则你展示所有手牌。然后你弃置其区域内X张牌。（X为其此阶段猜错的次数，若不足则全弃）' },
    { id: sid('fenwei-mou-ganning'), name: '奋威', description: '限定技，出牌阶段，你可以将至多三张牌置于任意名角色的武将牌上（每名角色各一张），称为“威”，然后你摸等量的牌。有“威”的角色成为锦囊牌的目标时，你须选择一项：1.令其获得“威”牌；2.弃置其“威”牌，取消其作为此锦囊牌的目标。' },
  ],
}
const MOU_HUANGGAI: CharacterDefinition = {
  id: 'mou-huanggai-b53', name: '谋·黄盖', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: sid('kurou-mou-huanggai'), name: '苦肉', description: '出牌阶段开始时，你可以交给其他角色一张牌，然后失去1点体力（若你交出的牌是【桃】或【酒】，则改为失去2点体力）。当你失去1点体力后，你获得2点护甲。' },
    { id: sid('zhaxiang-mou-huanggai'), name: '诈降', description: '锁定技，你于每个回合使用的前X张牌无距离和次数限制且不可被响应。摸牌阶段，你多摸X张牌。（X为你已损失体力值）' },
  ],
}
const MOU_SUNQUAN: CharacterDefinition = {
  id: 'mou-sunquan-b53', name: '谋·孙权', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: sid('zhiheng-mou-sunquan'), name: '制衡', description: '出牌阶段限一次，你可以弃置任意张牌，然后摸等量的牌。若你弃置了所有手牌，则额外摸X+1张牌（X为你拥有的“业”标记数量），然后移除一个“业”标记。' },
    { id: sid('tongye-mou-sunquan'), name: '统业', description: '锁定技，结束阶段，你须选择一项，直到下回合准备阶段：1.若场上的装备数变化，则你获得一个“业”标记，否则失去一个“业”标记；2.若场上的装备数不变，则你获得一个“业”标记，否则失去一个“业”标记。你至多拥有2个“业”标记。' },
    { id: sid('jiuyuan-mou-sunquan'), name: '救援', description: '主公技，锁定技，其他吴势力角色使用【桃】时，你摸一张牌。其他吴势力角色对你使用【桃】回复的体力+1。' },
  ],
}
const JIE_ZHANGYI: CharacterDefinition = {
  id: 'jie-zhangyi-b53', name: '界·张嶷', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'wind',
  skills: [
    { id: sid('wurong-jie-zhangyi'), name: '怃戎', description: '出牌阶段限一次，你可以与一名其他角色谋弈。若你选择镇压且其选择反抗，则你对其造成1点伤害，然后你摸一张牌。若你选择镇压且其选择归顺，则你获得其一张牌，然后交给其两张牌。若你选择安抚且其选择反抗，则你受到1点伤害，然后你摸一张牌。若你选择安抚且其选择归顺，则其交给你两张牌，若其的牌数不足两张，则改为跳过其的下一个摸牌阶段。' },
    { id: sid('shizhi-jie-zhangyi'), name: '矢志', description: '锁定技，当你体力值为1时，你的【闪】只能当做普通【杀】使用或打出。' },
  ],
}
const SHICHANGSHI: CharacterDefinition = {
  id: 'shichangshi-b53', name: '十常侍', kingdom: 'qun', gender: 'male', maxHp: 1, pack: 'sp',
  skills: [
    { id: sid('danggu-shichangshi'), name: '党锢', description: '锁定技。游戏开始时，你获得十张不同的“常侍”牌，然后你进行一次“结党”。当你休整结束移回游戏后，你进行一次“结党”，然后你摸一张牌。你获得你亮出“常侍”牌的技能。' },
    { id: sid('mowang-shichangshi'), name: '殁亡', description: '锁定技，你死亡后，若你拥有技能“党锢”，且你仍有未亮出的“常侍”牌，则改为休整一轮。回合结束后，你死亡。' },
    { id: sid('taoluan-shichangshi'), name: '滔乱', description: '出牌阶段限一次，当你需要使用一张基本牌或普通锦囊牌时，你可以将一张牌当此牌使用。', granted: true },
    { id: sid('chiyan-shichangshi'), name: '鸱咽', description: '当你使用【杀】指定目标后，你可以将其至多两张牌扣置于其武将牌旁；若如此做，当前回合结束后该角色获得这些牌。当你因执行你使用的【杀】的效果对一名角色造成伤害时，若你的手牌数和装备区牌数均不小于该角色，此伤害+1。', granted: true },
    { id: sid('zimou-shichangshi'), name: '自谋', description: '锁定技，当你于出牌阶段内使用第二、第四或第六张牌时，你分别从牌堆获得一张【酒】、【杀】或【决斗】。', granted: true },
    { id: sid('picai-shichangshi'), name: '庀材', description: '出牌阶段限一次，你可以判定；若结果与本阶段内此技能此前判定结果的花色均不同，你可以重复此流程。然后你将所有因此法生效的判定牌交给一名角色。', granted: true },
    { id: sid('yaozhuo-shichangshi'), name: '谣诼', description: '出牌阶段限一次，你可以与一名体力值不大于你的其他角色拼点。若你赢，其跳过其下个摸牌阶段；否则你弃置两张牌。', granted: true },
    { id: sid('xiaolu-shichangshi'), name: '宵赂', description: '出牌阶段限一次，你可以摸两张牌，然后选择一项：1.弃置两张手牌；2.将两张手牌交给一名其他角色。', granted: true },
    { id: sid('kuiji-shichangshi'), name: '窥机', description: '出牌阶段限一次，你可以观看一名其他角色的手牌，然后可以从你与其的手牌中弃置四张花色各不相同的牌。', granted: true },
    { id: sid('chixia-shichangshi'), name: '叱吓', description: '当你使用【杀】指定唯一目标后，你可以亮出牌堆顶两张牌；每有一张与此【杀】花色相同，此【杀】伤害基数+1，且目标不能使用亮出牌花色的牌响应此【杀】。', granted: true },
    { id: sid('niqu-shichangshi'), name: '逆取', description: '出牌阶段限一次，你可以对一名角色造成1点火焰伤害。', granted: true },
    { id: sid('miaoyu-shichangshi'), name: '妙语', description: '你可以将至多两张同花色牌按花色视为【桃】、火【杀】、【闪】或普通【无懈可击】使用或打出。以两张牌转化时，红色牌令回复值或伤害基数+1；黑色牌令你弃置当前回合角色一张牌。', granted: true },
  ],
}
const MOU_LUZHI: CharacterDefinition = {
  id: 'mou-luzhi-b53', name: '谋·卢植', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: sid('mingren-mou-luzhi'), name: '明任', description: '游戏开始时，你摸两张牌，然后将你的一张手牌扣置于你的武将牌上，称为“任”。结束阶段，你可以用手牌替换“任”。' },
    { id: sid('zhenliang-mou-luzhi'), name: '贞良', description: '转换技，阳：出牌阶段限一次，你可以选择一名攻击范围内的其他角色并弃置X张与“任”颜色相同的牌对其造成1点伤害（X为你与其体力值之差且至少为1）。阴：你的回合外，当一名角色使用或打出的牌结算结束后，若此牌与“任”类型相同，则你可令一名角色摸两张牌。' },
  ],
}
const MOU_ZHUGELIANG: CharacterDefinition = {
  id: 'mou-zhugeliang-b53', name: '谋·诸葛亮', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: sid('huoji-mou-zhugeliang'), name: '火计', description: '使命技，出牌阶段限一次，你可以选择一名其他角色，对其及其同势力的其他角色各造成1点火焰伤害。成功：准备阶段，若你本局游戏对其他角色造成过至少X点火焰伤害（X为本局游戏人数），你失去“火计”和“看破”，获得“观星※”和“空城※”。失败：成功达成使命前，进入濒死状态。' },
    { id: sid('kanpo-mou-zhugeliang'), name: '看破', description: '每轮开始时，你清除“看破”记录的牌名，然后你可以选择并记录任意个数的牌名（不可选择上次发动此技能记录过的牌名；每局游戏最多记录4个牌名，若为斗地主和排位赛模式则修改为2）。其他角色使用与你记录牌名相同的牌时，你可以移除一个对应牌名的记录，然后令此牌无效，且你摸一张牌。' },
    { id: sid('guixing-mou-zhugeliang'), name: '观星※', description: '准备阶段，你移去所有的“星”，并将牌堆顶的X张牌置于武将牌上（X为7-此前此技能准备阶段发动次数的三倍），称为“星”。然后你可以将任意张“星”牌置于牌堆顶。结束阶段，若你未于准备阶段将“星”牌置于牌堆顶，则你可以将任意张“星”牌置于牌堆顶。当你需要使用或打出手牌时，你可以将“星”视为你的牌使用或打出。' },
    { id: sid('kongcheng-mou-zhugeliang'), name: '空城※', description: '锁定技，当你受到伤害时，若你有技能“观星”且你的武将牌上有“星”，你进行一次判定，若判定结果点数小于等于你“星”牌的数量，则此伤害-1；若你有技能“观星”且你武将牌上没有“星”，你受到的伤害+1。' },
  ],
}
const MOU_GUANYU: CharacterDefinition = {
  id: 'mou-guanyu-b53', name: '谋·关羽', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: sid('wusheng-mou-guanyu'), name: '武圣', description: '你可以将一张手牌当作【杀】使用或打出。出牌阶段开始时，你可以指定一名主公以外的角色。此阶段：你对其使用【杀】无距离和次数限制；你使用【杀】指定其为目标后，你摸一张牌（若为身份场则修改为摸两张牌）；你对其使用三张【杀】后，不可再指定其为你使用【杀】的目标。' },
    { id: sid('yijue-mou-guanyu'), name: '义绝', description: '锁定技。一名其他角色于你的回合内受到你造成的伤害时，若此伤害会令其进入濒死状态，防止之（本局游戏每名角色限一次）。若如此做，直到回合结束，你使用牌指定其为目标时，取消之。' },
  ],
}

export const HISTORICAL_BATCH53_CHARACTERS: readonly CharacterDefinition[] = [
  MOU_FAZHENG, MOU_CHENGONG, MOU_GANNING, MOU_HUANGGAI, MOU_SUNQUAN,
  JIE_ZHANGYI, SHICHANGSHI, MOU_LUZHI, MOU_ZHUGELIANG, MOU_GUANYU,
]

type Batch53State = SanguoshaState & {
  b53Attendants?: Record<PlayerId, { revealed: string[]; records: Record<string, string> }>
  b53RestReturned?: Record<PlayerId, boolean>
  b53ShichangshiChixia?: Record<string, { ownerId: PlayerId; targetId: PlayerId; suits: string[]; bonus: number }>
  b53MiaoyuConversions?: Record<CardId, { ownerId: PlayerId; color: 'red' | 'black' | null; asCardName: string }>
  b53ZimouCount?: Record<PlayerId, number>
  b53Xuan?: Record<string, { ownerId: PlayerId; gained: number; taken: number }>
  b53Mingce?: Record<PlayerId, number>
  b53Zhichi?: Record<PlayerId, number>
  b53Zhixi?: Record<PlayerId, { count: number; guesserId: PlayerId; targetId: PlayerId; guesses: string[] }>
  b53DamageTurn?: Record<PlayerId, number>
  b53Industry?: Record<PlayerId, number>
  b53EquipPrediction?: Record<PlayerId, { mode: string; count: number; turn: number }>
  b53Reserved?: Record<PlayerId, CardId>
  b53ShaCount?: Record<PlayerId, { turn: number; count: number }>
  b53FreeCards?: CardId[]
  b53Wei?: Record<PlayerId, { ownerId: PlayerId; cardId: CardId }>
  b53PhaseUses?: Record<string, number>
  b53TargetBan?: Record<PlayerId, { turn: number; targetIds: PlayerId[] }>
  b53GuanyuTarget?: Record<PlayerId, { turn: number; targetId: PlayerId; slashes: number }>
  b53YiJueUsed?: Record<PlayerId, PlayerId[]>
  b53Ren?: Record<PlayerId, CardId>
  b53ZhenliangMode?: Record<PlayerId, 'yang' | 'yin'>
  b53MouZhugeFireDamage?: Record<PlayerId, number>
  b53MouZhugeStarPrepares?: Record<PlayerId, number>
  b53MouZhugeStarTopped?: Record<PlayerId, boolean>
  b53MouZhugeStarGrantedTurn?: Record<PlayerId, number>
  b53MouZhugeKanpo?: Record<PlayerId, { round: number; active: string[]; previous: string[]; total: number }>
  b53MouZhugeKanpoPlay?: { ownerId: PlayerId; sourceId: PlayerId; cardId: CardId; cardName: string; actionId: string; cancelled: boolean } | null
  b53MouZhugeKanpoDeclined?: Array<{ actionId: string; cardId: CardId }>
}

const FA_XUAN = sid('xuanhuo-mou-fazheng'), FA_EN = sid('enyuan-mou-fazheng')
const CH_MING = sid('mingce-mou-chengong'), CH_ZHI = sid('zhichi-mou-chengong')
const GN_QI = sid('qixi-mou-ganning'), GN_FEN = sid('fenwei-mou-ganning')
const HG_KU = sid('kurou-mou-huanggai'), HG_ZHA = sid('zhaxiang-mou-huanggai')
const SQ_ZHI = sid('zhiheng-mou-sunquan'), SQ_TONG = sid('tongye-mou-sunquan'), SQ_JIU = sid('jiuyuan-mou-sunquan')
const ZY_SHI = sid('shizhi-jie-zhangyi')
const ZY_WU = sid('wurong-jie-zhangyi'), ZY_WU_TAG = 'jie-zhangyi-wurong-b53'
const LZ_MING = sid('mingren-mou-luzhi'), LZ_ZHEN = sid('zhenliang-mou-luzhi')
const MZ_FIRE = sid('huoji-mou-zhugeliang'), MZ_KAN = sid('kanpo-mou-zhugeliang')
const MZ_STAR = sid('guixing-mou-zhugeliang'), MZ_EMPTY = sid('kongcheng-mou-zhugeliang')
const MZ_EMPTY_JUDGE = `${MZ_EMPTY}:judge`
const GY_WU = sid('wusheng-mou-guanyu'), GY_YI = sid('yijue-mou-guanyu')
const SS_DANG = sid('danggu-shichangshi'), SS_MOW = sid('mowang-shichangshi')
const SS_NIQU = sid('niqu-shichangshi'), SS_XIAO = sid('xiaolu-shichangshi'), SS_ZIMOU = sid('zimou-shichangshi')
const SS_KUIJI = sid('kuiji-shichangshi'), SS_PICAI = sid('picai-shichangshi')
const SS_PICAI_JUDGE = `${SS_PICAI}:judge`
const SS_TAOLUAN = sid('taoluan-shichangshi'), SS_CHIYAN = sid('chiyan-shichangshi')
const SS_CHIXIA = sid('chixia-shichangshi'), SS_MIAOYU = sid('miaoyu-shichangshi')
const SS_YAOZHUO = sid('yaozhuo-shichangshi'), SS_YAOZHUO_PINDIAN = `${SS_YAOZHUO}:pindian`

const SHICHANGSHI_CARDS = [
  { id: 'zhangrang', name: '张让', skillId: sid('taoluan-shichangshi') },
  { id: 'zhaozhong', name: '赵忠', skillId: sid('chiyan-shichangshi') },
  { id: 'sunzhang', name: '孙璋', skillId: sid('zimou-shichangshi') },
  { id: 'bilan', name: '毕岚', skillId: sid('picai-shichangshi') },
  { id: 'xiayun', name: '夏恽', skillId: sid('yaozhuo-shichangshi') },
  { id: 'hankui', name: '韩悝', skillId: sid('xiaolu-shichangshi') },
  { id: 'lisong', name: '栗嵩', skillId: sid('kuiji-shichangshi') },
  { id: 'duangui', name: '段珪', skillId: sid('chixia-shichangshi') },
  { id: 'guosheng', name: '郭胜', skillId: SS_NIQU },
  { id: 'gaowang', name: '高望', skillId: sid('miaoyu-shichangshi') },
] as const

const FORBIDDEN_MUTUAL_PAIRS = new Set(['bilan:hankui', 'hankui:bilan', 'duangui:guosheng', 'guosheng:duangui'])

function interceptMouKanpo(host: SkillHost, ownerId: PlayerId, context: { sourceId: PlayerId | null; targetId: PlayerId; cardId: CardId; cardName: string }): boolean {
  const entry = (host.state as Batch53State).b53MouZhugeKanpo?.[ownerId]
  const owner = player(host, ownerId)
  if (!owner?.alive || !entry?.active.includes(context.cardName) || context.sourceId === ownerId
    || host.state.skillResolution) return false
  host.askSkill({
    skillId: MZ_KAN, ownerId, step: 'intercept',
    data: { targetId: context.targetId, cardName: context.cardName },
    build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId,
      prompt: `【看破】：移去“${context.cardName}”记录，令此牌对本次结算无效并摸一张牌？`,
      timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '移去记录、令牌无效并摸一张' }, { id: 'no', label: '不发动' }],
    }),
  })
  return true
}

function player(host: SkillHost, id: PlayerId) { return host.state.players.find((p) => p.id === id) }
function others(host: SkillHost, id: PlayerId) { return host.state.players.filter((p) => p.alive && p.id !== id) }
function askCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, ids: CardId[], min: number, max: number, prompt: string, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId, prompt, timeoutMs: 30_000, optional, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min, max }) })
}
function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string, candidates: PlayerId[], data: Record<string, unknown> = {}, optional = true, targetId = ownerId) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: targetId, prompt, timeoutMs: 30_000, optional, candidateIds: candidates, min: 1, max: 1 }) })
}
function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, targetId: PlayerId, prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: targetId, prompt, timeoutMs: 30_000, optional, options }) })
}
function discard(host: SkillHost, ownerId: PlayerId, cardIds: CardId[], reason: string) {
  const owner = host.state.players.find((p) => p.id === ownerId)
  const done: CardId[] = []
  for (const cardId of cardIds) {
    const from = locateOwnedCard(host.state, ownerId, cardId)
    if (!from) continue
    moveCard(host.state, cardId, from, { kind: 'discardPile' }); done.push(cardId)
  }
  if (done.length) host.dispatch('LoseCard', { playerId: owner?.id, cardIds: done, reason }, { sourceId: ownerId, cardIds: done })
  return done
}

function shichangshiCanReveal(state: Batch53State, ownerId: PlayerId, candidateId: string): boolean {
  const cards = state.b53Attendants?.[ownerId]
  if (!cards) return false
  const hiddenCount = SHICHANGSHI_CARDS.filter((card) => !cards.revealed.includes(card.id)).length
  if (cards.revealed.some((revealedId) => cards.records[candidateId] === revealedId)) return false
  if (hiddenCount <= 2) return true
  return !cards.revealed.some((revealedId) => cards.records[revealedId] === candidateId)
}

function completeShichangshiParty(host: SkillHost, ownerId: PlayerId, candidateId: string, returning: boolean): void {
  const state = host.state as Batch53State
  const attendantState = state.b53Attendants?.[ownerId]
  const card = SHICHANGSHI_CARDS.find((candidate) => candidate.id === candidateId)
  if (!attendantState || !card || attendantState.revealed.includes(card.id)
    || !shichangshiCanReveal(state, ownerId, card.id)) return
  attendantState.revealed.push(card.id)
  grantSkill(host.state, ownerId, card.skillId)
  if (returning) drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
}

function beginShichangshiParty(host: SkillHost, ownerId: PlayerId, returning: boolean): void {
  const state = host.state as Batch53State
  const attendantState = state.b53Attendants?.[ownerId]
  if (!attendantState) return
  const hidden = SHICHANGSHI_CARDS.filter((card) => !attendantState.revealed.includes(card.id))
  if (hidden.length === 0) return

  const leader = host.rng.pick(hidden)
  attendantState.revealed.push(leader.id)
  grantSkill(host.state, ownerId, leader.skillId)
  const remaining = hidden.filter((card) => card.id !== leader.id)
  if (remaining.length === 0) {
    if (returning) drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    return
  }

  // 先随机观看至多四张，再按党锢的记录限制排除不合法同党。
  let viewed = host.rng.shuffle(remaining).slice(0, Math.min(4, remaining.length))
  let candidates = viewed.filter((card) => shichangshiCanReveal(state, ownerId, card.id))
  // 若本次随机四张恰好全被限制，重新从合法背面牌中随机观看，不把一个空选择窗口抛给玩家。
  if (candidates.length === 0) {
    const eligible = remaining.filter((card) => shichangshiCanReveal(state, ownerId, card.id))
    if (eligible.length === 0) {
      if (returning) drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      return
    }
    candidates = host.rng.shuffle(eligible).slice(0, Math.min(4, eligible.length))
  }
  if (candidates.length === 1) {
    completeShichangshiParty(host, ownerId, candidates[0]!.id, returning)
    return
  }

  const options = candidates.map((card) => ({
    id: card.id,
    label: `${card.name}（${SHICHANGSHI.skills.find((skill) => skill.id === card.skillId)?.name ?? '技能'}）`,
  }))
  host.askSkill({ skillId: SS_DANG, ownerId, step: 'partner', data: { candidateIds: candidates.map((card) => card.id), returning }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId,
    prompt: `【党锢】：随机亮出的常侍为“${leader.name}”，请选择一名合法同党`,
    timeoutMs: 30_000, optional: false, options,
  }) })
}

function randomShichangshiRecords(host: SkillHost): Record<string, string> {
  const ids = SHICHANGSHI_CARDS.map((card) => card.id)
  for (;;) {
    const targets = host.rng.shuffle(ids)
    const records = Object.fromEntries(ids.map((id, index) => [id, targets[index]!]))
    const valid = ids.every((id) => records[id] !== id)
      && ![...FORBIDDEN_MUTUAL_PAIRS].some((pair) => {
        const [from, to] = pair.split(':') as [string, string]
        return records[from] === to && records[to] === from
      })
    if (valid) return records
  }
}

// 【眩惑】按每个持有者单独记录诱牌、所得牌数与夺牌数；摸牌阶段内获得牌不触发。
registerSkillRuntime({ id: FA_XUAN,
  activeActions(state, ownerId) {
    const owner = state.players.find((p) => p.id === ownerId)
    if (!owner?.alive || owner.characterId !== MOU_FAZHENG.id || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, FA_XUAN) || ![...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))].length) return []
    return state.players.some((p) => p.alive && p.id !== ownerId && !p.marks.b53Xuan)
      ? [{ id: `skill:${FA_XUAN}`, label: '眩惑：交给一名没有“眩”的角色一张牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${FA_XUAN}` || usedThisPhase(host.state, ownerId, FA_XUAN)) return
    const owner = player(host, ownerId)
    const candidates = others(host, ownerId).filter((p) => !p.marks.b53Xuan).map((p) => p.id)
    if (!owner || !candidates.length) return
    askTargets(host, FA_XUAN, ownerId, 'target', '【眩惑】：选择一名未有“眩”标记的其他角色', candidates)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = player(host, ownerId)
      const target = targetId ? player(host, targetId) : undefined
      if (!owner?.alive || !target?.alive || target.id === ownerId || target.marks.b53Xuan) return
      const ids = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      if (ids.length) askCards(host, FA_XUAN, ownerId, 'give', ownerId, ids, 1, 1, '【眩惑】：选择交给目标的一张牌', { targetId }, false)
      return
    }
    if (resolution.step === 'give') {
      const targetId = (resolution.data as { targetId?: PlayerId }).targetId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = player(host, ownerId)
      const target = targetId ? player(host, targetId) : undefined
      if (!owner?.alive || !target?.alive || target.marks.b53Xuan || !cardId) return
      const moved = giveCards(host as never, ownerId, target.id, [cardId], FA_XUAN)
      if (!moved.includes(cardId)) return
      target.marks.b53Xuan = 1
      ;((host.state as Batch53State).b53Xuan ??= {})[`${ownerId}:${target.id}`] = { ownerId, gained: 0, taken: 0 }
      markUsedThisPhase(host.state, ownerId, FA_XUAN)
    }
  },
  triggers: [{ event: 'GainCard', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    const target = payload.playerId ? player(host, payload.playerId) : undefined
    const state = host.state as Batch53State
    const marker = target && state.b53Xuan?.[`${ownerId}:${target.id}`]
    if (!marker || !target?.alive || !player(host, ownerId)?.alive || target.id === ownerId
      || (context.event.phase === 'draw' || host.state.phase === 'draw') || marker.taken >= 5) return
    const gained = (payload.cardIds ?? []).filter((id) => target.zones.hand.includes(id))
    if (!gained.length) return
    marker.gained += gained.length
    const available = [...target.zones.hand]
    const count = Math.min(gained.length, 5 - marker.taken, available.length)
    for (let i = 0; i < count; i++) {
      const index = host.rng.nextInt(available.length)
      const cardId = available.splice(index, 1)[0]!
      moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: FA_XUAN }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
      marker.taken++
    }
  } }],
})

// 【恩怨】准备阶段逐一处理仍有“眩”的角色；转牌与失去体力均走引擎公共路径。
registerSkillRuntime({ id: FA_EN,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    if (phase.playerId !== ownerId || phase.phase !== 'prepare' || !player(host, ownerId)?.alive) return
    const targets = host.state.players.filter((p) => p.alive && p.id !== ownerId && p.marks.b53Xuan)
    if (targets.length) host.queueSkill({ skillId: FA_EN, ownerId, step: 'next', data: { targetIds: targets.map((p) => p.id), index: 0 } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'next') return
    resolveEnyuan(host, ownerId, prompt.data as { targetIds: PlayerId[]; index: number })
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { targetIds: PlayerId[]; index: number; targetId?: PlayerId }
    const targetId = data.targetId ?? data.targetIds[data.index]
    const target = targetId ? player(host, targetId) : undefined
    if (!target?.alive || !player(host, ownerId)?.alive) { resolveEnyuan(host, ownerId, { targetIds: data.targetIds, index: data.index + 1 }); return }
    if (resolution.step === 'give') {
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = ids.filter((id) => player(host, ownerId)?.zones.hand.includes(id)).slice(0, 3)
      if (valid.length === 3) giveCards(host as never, ownerId, target.id, valid, FA_EN)
      delete target.marks.b53Xuan
      delete (host.state as Batch53State).b53Xuan?.[`${ownerId}:${target.id}`]
      resolveEnyuan(host, ownerId, { targetIds: data.targetIds, index: data.index + 1 })
    }
  },
})

function resolveEnyuan(host: SkillHost, ownerId: PlayerId, data: { targetIds: PlayerId[]; index: number }): void {
  let index = data.index
  while (index < data.targetIds.length && !player(host, data.targetIds[index]!)?.marks.b53Xuan) index++
  const targetId = data.targetIds[index]
  const target = targetId ? player(host, targetId) : undefined
  const owner = player(host, ownerId)
  if (!target || !target.alive || !owner?.alive) return
  const marker = (host.state as Batch53State).b53Xuan?.[`${ownerId}:${target.id}`]
  if ((marker?.gained ?? 0) >= 3) {
    if (owner.zones.hand.length >= 3) askCards(host, FA_EN, ownerId, 'give', ownerId, [...owner.zones.hand], 3, 3, '【恩怨】：交给其三张手牌', { targetIds: data.targetIds, index, targetId }, false)
    else { delete target.marks.b53Xuan; delete (host.state as Batch53State).b53Xuan?.[`${ownerId}:${target.id}`]; resolveEnyuan(host, ownerId, { targetIds: data.targetIds, index: index + 1 }) }
    return
  }
  delete target.marks.b53Xuan
  delete (host.state as Batch53State).b53Xuan?.[`${ownerId}:${target.id}`]
  loseHp(host as never, target.id, 1, FA_EN)
  if (player(host, ownerId)?.alive) recover(host as never, ownerId, 1, ownerId)
  resolveEnyuan(host, ownerId, { targetIds: data.targetIds, index: index + 1 })
}

// 【明策】转交实体牌后由接收者选择；策点结算为原生伤害链。
registerSkillRuntime({ id: CH_MING,
  activeActions(state, ownerId) {
    const owner = state.players.find((p) => p.id === ownerId)
    if (!owner?.alive || owner.characterId !== MOU_CHENGONG.id || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, CH_MING) || ![...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))].length
      || !state.players.some((p) => p.alive && p.id !== ownerId)) return []
    return [{ id: `skill:${CH_MING}`, label: '明策：交给一名其他角色一张牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${CH_MING}`) return
    const owner = player(host, ownerId)
    if (!owner?.alive) return
    const targets = others(host, ownerId).map((p) => p.id)
    askTargets(host, CH_MING, ownerId, 'target', '【明策】：选择获得牌的角色', targets)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'spend') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const candidates = others(host, ownerId).map((p) => p.id)
      if (candidates.length) askTargets(host, CH_MING, ownerId, 'spend-target', '【明策】：选择受到伤害的角色', candidates,
        { count: Math.min(player(host, ownerId)?.marks.b53Ce ?? 0, (resolution.data as { count?: number }).count ?? 0) })
      return
    }
    if (resolution.step === 'spend-target') {
      const data = resolution.data as { count?: number }
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = player(host, ownerId)
      if (!targetId || !owner?.alive || !player(host, targetId)?.alive) return
      const amount = Math.min(owner.marks.b53Ce ?? 0, data.count ?? 0)
      owner.marks.b53Ce = Math.max(0, (owner.marks.b53Ce ?? 0) - amount)
      if (!owner.marks.b53Ce) delete owner.marks.b53Ce
      if (amount) resolveDamage(host as never, { sourceId: ownerId, targetId, amount, nature: 'normal', cardName: '明策' })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const ids = player(host, ownerId) ? [...player(host, ownerId)!.zones.hand, ...Object.values(player(host, ownerId)!.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      if (targetId && player(host, targetId)?.alive && ids.length) askCards(host, CH_MING, ownerId, 'give', ownerId, ids, 1, 1, '【明策】：选择交给目标的一张牌', { targetId }, false)
      return
    }
    if (resolution.step === 'give') {
      const targetId = (resolution.data as { targetId?: PlayerId }).targetId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!targetId || !cardId || !player(host, targetId)?.alive || !giveCards(host as never, ownerId, targetId, [cardId], CH_MING).includes(cardId)) return
      markUsedThisPhase(host.state, ownerId, CH_MING)
      const target = player(host, targetId)!
      askOption(host, CH_MING, ownerId, 'choice', target.id, '【明策】：选择一项', [
        { id: 'hp-loss', label: '失去1点体力；陈宫摸两张牌并获得1个“策”' }, { id: 'draw', label: '摸一张牌' },
      ], { targetId }, false)
      return
    }
    if (resolution.step === 'choice') {
      const targetId = (resolution.data as { targetId?: PlayerId }).targetId
      const option = (response.payload as { optionId?: string }).optionId
      const target = targetId ? player(host, targetId) : undefined
      if (!target?.alive) return
      if (option === 'hp-loss') {
        loseHp(host as never, target.id, 1, CH_MING)
        const owner = player(host, ownerId)
        if (owner?.alive) { drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload)); owner.marks.b53Ce = (owner.marks.b53Ce ?? 0) + 1 }
      } else if (option === 'draw') drawCards(host.state, host.rng, target.id, 1, (name, payload) => host.dispatch(name, payload))
    }
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    const owner = player(host, ownerId)
    const count = owner?.marks.b53Ce ?? 0
    if (phase.playerId !== ownerId || phase.phase !== 'play' || !count || !owner?.alive) return
    askOption(host, CH_MING, ownerId, 'spend', ownerId, `【明策】：是否移去${count}个“策”对一名其他角色造成${count}点伤害？`, [
      { id: 'yes', label: '发动' }, { id: 'no', label: '不发动' },
    ], { count }, true)
  } }],
})

registerSkillRuntime({ id: CH_ZHI,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || !player(host, ownerId)?.alive) return
    ;((host.state as Batch53State).b53Zhichi ??= {})[ownerId] = host.state.turnNumber
  } }],
  interceptIncomingDamage(host, ownerId) {
    return (host.state as Batch53State).b53Zhichi?.[ownerId] === host.state.turnNumber
  },
})
registerSkillRuntime({ id: GN_QI,
  activeActions(state, ownerId) {
    const owner = state.players.find((p) => p.id === ownerId)
    return owner?.alive && owner.characterId === MOU_GANNING.id && state.phase === 'play'
      && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, GN_QI)
      && owner.zones.hand.length > 0 && state.players.some((p) => p.alive && p.id !== ownerId)
      ? [{ id: `skill:${GN_QI}`, label: '奇袭：令一名其他角色猜测你手牌最多的花色' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${GN_QI}`) return
    const candidates = others(host, ownerId).map((p) => p.id)
    if (candidates.length) askTargets(host, GN_QI, ownerId, 'target', '【奇袭】：选择猜测你手牌花色的角色', candidates)
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { targetId?: PlayerId; guesses?: string[]; wrong?: number }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && player(host, targetId)?.alive && player(host, ownerId)?.zones.hand.length)
        askQixiGuess(host, ownerId, targetId, [], 0)
      return
    }
    if (resolution.step === 'guess') {
      const targetId = data.targetId
      if (!targetId || !player(host, targetId)?.alive || !player(host, ownerId)?.alive) return
      const suit = (response.payload as { optionId?: string }).optionId
      if (!['spade', 'heart', 'club', 'diamond'].includes(suit ?? '') || data.guesses?.includes(suit!)) return
      const owner = player(host, ownerId)!
      const counts = new Map<string, number>(['spade', 'heart', 'club', 'diamond'].map((s) => [s, 0]))
      for (const id of owner.zones.hand) {
        const cardSuit = host.state.cards[id]?.suit
        if (cardSuit) counts.set(cardSuit, (counts.get(cardSuit) ?? 0) + 1)
      }
      const max = Math.max(...counts.values())
      const correct = (counts.get(suit!) ?? 0) === max
      const guesses = [...(data.guesses ?? []), suit!]
      const wrong = Number(data.wrong ?? 0) + Number(!correct)
      if (!correct && guesses.length < 4) askOption(host, GN_QI, ownerId, 'continue', ownerId,
        '【奇袭】：其猜错了，是否令其再猜一种未猜过的花色？', [
          { id: 'again', label: '再猜一次' }, { id: 'stop', label: '停止猜测并展示手牌' },
        ], { targetId, guesses, wrong }, true)
      else finishQixi(host, ownerId, targetId, wrong)
      return
    }
    if (resolution.step === 'continue') {
      const again = (response.payload as { optionId?: string }).optionId === 'again'
      if (again) askQixiGuess(host, ownerId, data.targetId!, data.guesses ?? [], data.wrong ?? 0)
      else finishQixi(host, ownerId, data.targetId!, data.wrong ?? 0)
      return
    }
    if (resolution.step === 'discard') {
      const targetId = data.targetId
      const target = targetId ? player(host, targetId) : undefined
      const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const resolved = target?.alive ? selected.map((picked) => resolvePickedCard(host.state, target.id, picked)).filter((id): id is CardId => Boolean(id)) : []
      if (target?.alive) for (const cardId of resolved) {
        const from = locateOwnedCard(host.state, target.id, cardId)
        if (from?.kind === 'equipment' || from?.kind === 'judgingArea')
          movePickedCard(host as never, target.id, cardId, { kind: 'discardPile' })
        else if (from?.kind === 'hand') {
          moveCard(host.state, cardId, from, { kind: 'discardPile' })
          host.dispatch('LoseCard', { playerId: target.id, cardIds: [cardId], reason: GN_QI }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
        }
      }
    }
  },
})

function askQixiGuess(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, guesses: string[], wrong: number): void {
  const suits = ['spade', 'heart', 'club', 'diamond'].filter((suit) => !guesses.includes(suit))
  if (!suits.length) { finishQixi(host, ownerId, targetId, wrong); return }
  askOption(host, GN_QI, ownerId, 'guess', targetId, '【奇袭】：猜测甘宁手牌中数量最多（或并列最多）的花色',
    suits.map((id) => ({ id, label: id === 'spade' ? '黑桃' : id === 'heart' ? '红桃' : id === 'club' ? '梅花' : '方块' })),
    { targetId, guesses, wrong }, false)
}

function finishQixi(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, wrong: number): void {
  const owner = player(host, ownerId)
  const target = player(host, targetId)
  if (!owner?.alive || !target?.alive) return
  host.dispatch('CardMove', { playerId: ownerId, cardIds: [...owner.zones.hand], reason: GN_QI, revealed: true }, { sourceId: ownerId, targetId, cardIds: [...owner.zones.hand] })
  host.dispatch('SkillActivated', { skillId: GN_QI, skillName: '奇袭', targetIds: [targetId] }, { sourceId: ownerId, targetId })
  markUsedThisPhase(host.state, ownerId, GN_QI)
  const pickable = pickableCardsOf(host.state, target.id, { includeJudgingArea: true, discarderId: ownerId })
  const total = pickable.cardIds.length + pickable.hiddenCardSlots.length
  if (!wrong || !total) return
  const count = Math.min(wrong, total)
  host.askSkill({ skillId: GN_QI, ownerId, step: 'discard', data: { targetId, wrong }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【奇袭】：弃置目标区域内${count}张牌`, timeoutMs: 30_000,
    optional: false, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: count, max: count,
  }) })
}

registerSkillRuntime({ id: GN_FEN, limited: true,
  activeActions(state, ownerId) {
    const owner = state.players.find((p) => p.id === ownerId)
    return owner?.alive && owner.characterId === MOU_GANNING.id && state.phase === 'play'
      && state.currentPlayerId === ownerId && !owner.usedLimitedSkills.includes(GN_FEN) && owner.zones.hand.length > 0
      ? [{ id: `skill:${GN_FEN}`, label: '奋威：置最多三张牌于角色武将牌上' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    const owner = player(host, ownerId)
    if (actionId !== `skill:${GN_FEN}` || !owner?.alive || owner.usedLimitedSkills.includes(GN_FEN)) return
    askCards(host, GN_FEN, ownerId, 'cards', ownerId, [...owner.zones.hand], 1, Math.min(3, owner.zones.hand.length), '【奋威】：选择置于角色武将牌上的1至3张手牌', {}, false)
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { ids?: CardId[]; index?: number; placed?: number; selectedTargets?: PlayerId[]; targetId?: PlayerId; cardId?: CardId }
    if (resolution.step === 'cards') {
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = player(host, ownerId)
      if (!owner?.alive || !ids.length || ids.length > 3 || new Set(ids).size !== ids.length || ids.some((id) => !owner.zones.hand.includes(id))) return
      owner.usedLimitedSkills.push(GN_FEN)
      placeWeiNext(host, ownerId, ids, 0, [])
      return
    }
    if (resolution.step === 'recipient') {
      const ids = data.ids ?? []
      const index = data.index ?? 0
      const cardId = ids[index]
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = player(host, ownerId)
      const target = targetId ? player(host, targetId) : undefined
      const chosen = data.selectedTargets ?? []
      if (!cardId || !owner?.alive || !target?.alive || chosen.includes(target.id) || !owner.zones.hand.includes(cardId)) {
        placeWeiNext(host, ownerId, ids, index + 1, chosen, data.placed ?? 0); return
      }
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: target.id, pile: 'fenwei' })
      ;((host.state as Batch53State).b53Wei ??= {})[target.id] = { ownerId, cardId }
      host.dispatch('CharacterPileMoved', { playerId: target.id, pile: 'fenwei', count: target.characterPiles.fenwei?.length ?? 1 }, { sourceId: ownerId, targetId: target.id })
      placeWeiNext(host, ownerId, ids, index + 1, [...chosen, target.id], (data.placed ?? 0) + 1)
      return
    }
    if (resolution.step === 'fengwei-target') {
      const state = host.state as Batch53State
      const mark = state.b53Wei?.[data.targetId ?? '']
      const target = data.targetId ? player(host, data.targetId) : undefined
      if (mark && target?.characterPiles.fenwei?.includes(mark.cardId)) {
        const option = (response.payload as { optionId?: string }).optionId
        delete state.b53Wei?.[target.id]
        if (option === 'take') {
          moveCard(host.state, mark.cardId, { kind: 'characterPile', playerId: target.id, pile: 'fenwei' }, { kind: 'hand', playerId: target.id })
          host.dispatch('GainCard', { playerId: target.id, cardIds: [mark.cardId], reason: GN_FEN }, { sourceId: mark.ownerId, targetId: target.id, cardIds: [mark.cardId] })
        } else {
          moveCard(host.state, mark.cardId, { kind: 'characterPile', playerId: target.id, pile: 'fenwei' }, { kind: 'discardPile' })
          const card = host.state.cardResolution
          if (card?.kind === 'trick' && card.cardId === data.cardId && !card.cancelledTargetIds.includes(target.id)) card.cancelledTargetIds.push(target.id)
        }
      }
      host.resumeCardTarget()
    }
  },
  interceptBystanderTarget(host, ownerId, context) {
    if (context.category !== 'trick' || context.targetId === ownerId) return false
    const mark = (host.state as Batch53State).b53Wei?.[context.targetId]
    const target = player(host, context.targetId)
    if (!mark || mark.ownerId !== ownerId || !target?.characterPiles.fenwei?.includes(mark.cardId) || !player(host, ownerId)?.alive) return false
    askOption(host, GN_FEN, ownerId, 'fengwei-target', ownerId, '【奋威】：令其获得“威”牌，或弃置“威”牌并取消其此锦囊目标', [
      { id: 'take', label: '令其获得“威”牌' }, { id: 'cancel', label: '弃置“威”牌并取消其目标' },
    ], { targetId: context.targetId, cardId: context.cardId }, false)
    return true
  },
})

function placeWeiNext(host: SkillHost, ownerId: PlayerId, ids: CardId[], index: number, selectedTargets: PlayerId[], placed = 0): void {
  if (index >= ids.length || !player(host, ownerId)?.alive) {
    if (placed) drawCards(host.state, host.rng, ownerId, placed, (name, payload) => host.dispatch(name, payload))
    return
  }
  const state = host.state as Batch53State
  const candidates = host.state.players.filter((p) => p.alive && !selectedTargets.includes(p.id)
    && !state.b53Wei?.[p.id]).map((p) => p.id)
  if (!candidates.length) { placeWeiNext(host, ownerId, ids, index + 1, selectedTargets, placed); return }
  askTargets(host, GN_FEN, ownerId, 'recipient', `【奋威】：为第${index + 1}张牌选择一名未放置过“威”牌的角色`, candidates,
    { ids, index, selectedTargets, placed })
}
registerSkillRuntime({ id: HG_KU, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
  const owner = player(host, ownerId)
  if (phase.playerId !== ownerId || phase.phase !== 'play' || !owner?.alive || owner.characterId !== MOU_HUANGGAI.id) return
  const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
  const targets = others(host, ownerId).map((p) => p.id)
  if (!cards.length || !targets.length) return
  host.askSkill({ skillId: HG_KU, ownerId, step: 'recipient', data: {}, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【苦肉】：是否交给一名其他角色一张牌并失去体力？',
    timeoutMs: 30_000, optional: true, candidateIds: targets, min: 0, max: 1,
  }) })
} }, { event: 'LoseHp', handle(host, ownerId, context) {
  if (context.event.targetId !== ownerId || !player(host, ownerId)?.alive) return
  const amount = Math.max(0, Number((context.event.payload as { amount?: number }).amount ?? 0))
  for (let i = 0; i < amount; i++) gainArmor(host as never, ownerId, 2, HG_KU)
} }], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'recipient') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !player(host, targetId)?.alive) return
    const owner = player(host, ownerId)
    if (!owner?.alive) return
    const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    if (cards.length) askCards(host, HG_KU, ownerId, 'card', ownerId, cards, 1, 1, '【苦肉】：选择交给目标的一张牌', { targetId }, false)
    return
  }
  if (resolution.step === 'card') {
    const targetId = (resolution.data as { targetId?: PlayerId }).targetId
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const owner = player(host, ownerId)
    if (!targetId || !cardId || !owner?.alive || !player(host, targetId)?.alive) return
    if (!giveCards(host as never, ownerId, targetId, [cardId], HG_KU).includes(cardId)) return
    loseHp(host as never, ownerId, ['桃', '酒'].includes(host.state.cards[cardId]?.name ?? '') ? 2 : 1, HG_KU)
  }
} })

registerSkillRuntime({ id: LZ_MING,
  onGameStart(host, ownerId) {
    if (!player(host, ownerId)?.alive) return
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
    const owner = player(host, ownerId)!
    if (owner.zones.hand.length) askCards(host, LZ_MING, ownerId, 'initial', ownerId, [...owner.zones.hand], 1, 1,
      '【明任】：选择一张手牌扣置为“任”', {}, false)
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    const owner = player(host, ownerId)
    const reserved = (host.state as Batch53State).b53Ren?.[ownerId]
    if (phase.playerId !== ownerId || phase.phase !== 'finish' || !owner?.alive || !reserved || !owner.zones.hand.length) return
    askCards(host, LZ_MING, ownerId, 'replace', ownerId, [...owner.zones.hand], 1, 1, '【明任】：选择一张手牌替换“任”', {}, true)
  } }],
  resume(host, ownerId, resolution, response) {
    const owner = player(host, ownerId)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!owner?.alive || !selected || !owner.zones.hand.includes(selected)) return
    const state = host.state as Batch53State
    const old = state.b53Ren?.[ownerId]
    if (resolution.step === 'replace' && old) moveCard(host.state, old, { kind: 'characterPile', playerId: ownerId, pile: 'ren' }, { kind: 'hand', playerId: ownerId })
    else if (resolution.step !== 'initial') return
    moveCard(host.state, selected, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: 'ren' })
    ;(state.b53Ren ??= {})[ownerId] = selected
    host.dispatch('CharacterPileMoved', { playerId: ownerId, pile: 'ren', count: 1 }, { sourceId: ownerId, targetId: ownerId })
  },
})

registerSkillRuntime({ id: LZ_ZHEN,
  onGameStart(_host, ownerId) { /* 阳为起始转换状态 */
    ;((_host.state as Batch53State).b53ZhenliangMode ??= {})[ownerId] = 'yang'
  },
  activeActions(state, ownerId) {
    const owner = state.players.find((p) => p.id === ownerId)
    const ren = (state as Batch53State).b53Ren?.[ownerId]
    const mode = (state as Batch53State).b53ZhenliangMode?.[ownerId] ?? 'yang'
    if (!owner?.alive || owner.characterId !== MOU_LUZHI.id || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || mode !== 'yang' || usedThisPhase(state, ownerId, LZ_ZHEN) || !ren) return []
    const color = state.cards[ren]?.color
    const eligible = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      .filter((id) => color && effectiveCardColor(state, ownerId, id) === color)
    const targets = state.players.filter((target) => target.alive && target.id !== ownerId
      && canTarget(state, ownerId, target.id) && eligible.length >= Math.max(1, Math.abs(owner.hp - target.hp)))
    return targets.length ? [{ id: `skill:${LZ_ZHEN}`, label: '贞良·阳：弃置同色牌，对范围内角色造成伤害' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${LZ_ZHEN}`) return
    const owner = player(host, ownerId)
    const ren = (host.state as Batch53State).b53Ren?.[ownerId]
    const color = ren ? host.state.cards[ren]?.color : undefined
    if (!owner?.alive || !ren || !color) return
    const eligible = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      .filter((id) => effectiveCardColor(host.state, ownerId, id) === color)
    const targets = host.state.players.filter((target) => target.alive && target.id !== ownerId && canTarget(host.state, ownerId, target.id)
      && eligible.length >= Math.max(1, Math.abs(owner.hp - target.hp))).map((target) => target.id)
    if (targets.length) askTargets(host, LZ_ZHEN, ownerId, 'yang-target', '【贞良·阳】：选择攻击范围内的其他角色', targets)
  },
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    if (host.state.currentPlayerId === ownerId || !player(host, ownerId)?.alive
      || (host.state as Batch53State).b53ZhenliangMode?.[ownerId] !== 'yin') return
    const payload = context.event.payload as { cardName?: string; cardId?: CardId }
    const ren = (host.state as Batch53State).b53Ren?.[ownerId]
    const category = ren && host.state.cards[ren]?.category
    const actualCategory = payload.cardName
      ? Object.values(host.state.cards).find((card) => card.name === payload.cardName)?.category
      : payload.cardId ? host.state.cards[payload.cardId]?.category : undefined
    if (!category || actualCategory !== category) return
    askTargets(host, LZ_ZHEN, ownerId, 'yin-target', '【贞良·阴】：是否令一名角色摸两张牌？',
      host.state.players.filter((p) => p.alive).map((p) => p.id), {}, true)
  } }, { event: 'CardResponded', handle(host, ownerId, context) {
    if (host.state.currentPlayerId === ownerId || !player(host, ownerId)?.alive
      || (host.state as Batch53State).b53ZhenliangMode?.[ownerId] !== 'yin') return
    const payload = context.event.payload as { cardName?: string; cardId?: CardId }
    const ren = (host.state as Batch53State).b53Ren?.[ownerId]
    const category = ren && host.state.cards[ren]?.category
    const actualCategory = payload.cardName
      ? Object.values(host.state.cards).find((card) => card.name === payload.cardName)?.category
      : payload.cardId ? host.state.cards[payload.cardId]?.category : undefined
    if (!category || actualCategory !== category) return
    askTargets(host, LZ_ZHEN, ownerId, 'yin-target', '【贞良·阴】：是否令一名角色摸两张牌？',
      host.state.players.filter((p) => p.alive).map((p) => p.id), {}, true)
  } }],
  resume(host, ownerId, resolution, response) {
    const state = host.state as Batch53State
    const owner = player(host, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'yang-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host, targetId) : undefined
      const ren = state.b53Ren?.[ownerId]
      if (!target?.alive || !ren || !canTarget(host.state, ownerId, target.id)) return
      const count = Math.max(1, Math.abs(owner.hp - target.hp))
      const color = host.state.cards[ren]?.color
      const ids = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
        .filter((id) => color && effectiveCardColor(host.state, ownerId, id) === color)
      if (ids.length < count) return
      askCards(host, LZ_ZHEN, ownerId, 'yang-discard', ownerId, ids, count, count,
        `【贞良·阳】：弃置${count}张与“任”颜色相同的牌`, { targetId }, false)
      return
    }
    if (resolution.step === 'yang-discard') {
      const targetId = (resolution.data as { targetId?: PlayerId }).targetId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const target = targetId ? player(host, targetId) : undefined
      const ren = state.b53Ren?.[ownerId]
      const color = ren ? host.state.cards[ren]?.color : undefined
      if (!target?.alive || !color || ids.length !== Math.max(1, Math.abs(owner.hp - target.hp))
        || ids.some((id) => effectiveCardColor(host.state, ownerId, id) !== color || !locateOwnedCard(host.state, ownerId, id))) return
      discard(host, ownerId, ids, LZ_ZHEN)
      markUsedThisPhase(host.state, ownerId, LZ_ZHEN)
      state.b53ZhenliangMode ??= {}; state.b53ZhenliangMode[ownerId] = 'yin'
      resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: 1, nature: 'normal', cardName: '贞良' })
      return
    }
    if (resolution.step === 'yin-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !player(host, targetId)?.alive) return
      state.b53ZhenliangMode ??= {}; state.b53ZhenliangMode[ownerId] = 'yang'
      drawCards(host.state, host.rng, targetId, 2, (name, payload) => host.dispatch(name, payload))
    }
  },
})

registerSkillRuntime({ id: MZ_FIRE,
  activeActions(state, ownerId) {
    const owner = state.players.find((candidate) => candidate.id === ownerId)
    if (!owner?.alive || owner.characterId !== MOU_ZHUGELIANG.id || state.phase !== 'play'
      || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, MZ_FIRE)
      || !missionInProgress(state, ownerId, MZ_FIRE)
      || !state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: `skill:${MZ_FIRE}`, label: '火计：对一名角色及其同势力角色造成火焰伤害' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${MZ_FIRE}`) return
    const targets = others(host, ownerId).map((candidate) => candidate.id)
    if (targets.length) askTargets(host, MZ_FIRE, ownerId, 'target', '【火计】：选择一名其他角色', targets, {}, false)
  },
  triggers: [
    { event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.damageNature !== 'fire'
        || context.event.targetId === ownerId || !missionInProgress(host.state, ownerId, MZ_FIRE)) return
      const amount = Math.max(0, Number((context.event.payload as { amount?: number }).amount ?? 0))
      if (amount) {
        const ledger = (host.state as Batch53State).b53MouZhugeFireDamage ??= {}
        ledger[ownerId] = (ledger[ownerId] ?? 0) + amount
      }
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (phase.playerId !== ownerId || phase.phase !== 'prepare' || !missionInProgress(host.state, ownerId, MZ_FIRE)) return
      const total = (host.state as Batch53State).b53MouZhugeFireDamage?.[ownerId] ?? 0
      if (total < host.state.players.length || !finishMission(host.state, ownerId, MZ_FIRE, 'success')) return
      const owner = player(host, ownerId)
      if (!owner) return
      owner.permanentlyLostSkills ??= []
      for (const skillId of [MZ_FIRE, MZ_KAN]) if (!owner.permanentlyLostSkills.includes(skillId)) owner.permanentlyLostSkills.push(skillId)
      grantSkill(host.state, ownerId, MZ_STAR)
      grantSkill(host.state, ownerId, MZ_EMPTY)
      ;((host.state as Batch53State).b53MouZhugeStarGrantedTurn ??= {})[ownerId] = host.state.turnNumber
      host.dispatch('SkillActivated', {
        skillId: MZ_FIRE, skillName: '火计', playerId: ownerId, result: 'mission-success',
        grantedSkillIds: [MZ_STAR, MZ_EMPTY],
      }, { sourceId: ownerId })
    } },
    { event: 'EnterDying', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId || !missionInProgress(host.state, ownerId, MZ_FIRE)) return
      finishMission(host.state, ownerId, MZ_FIRE, 'failure')
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target' || !missionInProgress(host.state, ownerId, MZ_FIRE)) return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? player(host, targetId) : undefined
    if (!target?.alive || target.id === ownerId) return
    const kingdom = effectiveKingdomOf(host.state, target.id)
    const targetIds = host.state.players
      .filter((candidate) => candidate.alive && candidate.id !== ownerId
        && (candidate.id === target.id || effectiveKingdomOf(host.state, candidate.id) === kingdom))
      .map((candidate) => candidate.id)
    markUsedThisPhase(host.state, ownerId, MZ_FIRE)
    resolveDamageSequence(host as never, {
      sourceId: ownerId, targetIds, amount: 1, nature: 'fire', cardId: null, cardName: '火计',
    })
  },
})

registerSkillRuntime({ id: MZ_KAN,
  interceptTarget(host, ownerId, context) {
    if (context.category !== 'trick' && context.cardName !== '杀') return false
    return interceptMouKanpo(host, ownerId, context)
  },
  interceptBystanderTarget(host, ownerId, context) {
    if (context.category !== 'trick' && context.cardName !== '杀') return false
    return interceptMouKanpo(host, ownerId, context)
  },
  interceptPlayAction(host, ownerId, action) {
    const state = host.state as Batch53State
    if (action.kind !== 'use-card') return false
    const entry = state.b53MouZhugeKanpo?.[ownerId]
    const cardName = action.asCardName
    if (!entry?.active.includes(cardName) || action.playerId === ownerId
      || action.id.startsWith('play:recast:') || state.b53MouZhugeKanpoPlay) return false
    if (state.b53MouZhugeKanpoDeclined?.some((declined) => declined.actionId === action.id)) return false
    host.askSkill({ skillId: MZ_KAN, ownerId, step: 'play-intercept', data: { action, cardName }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId,
      prompt: `【看破】：移去“${cardName}”记录，令${player(host, action.playerId)?.nickname ?? '该角色'}使用的此牌无效并摸一张牌？`,
      timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '移去记录，使此牌无效并摸一张牌' }, { id: 'no', label: '不发动' }],
    }) })
    return true
  },
  triggers: [
    { event: 'RoundStart', handle(host, ownerId) {
    const state = host.state as Batch53State
    const table = state.b53MouZhugeKanpo ??= {}
    const previous = table[ownerId]
    if (previous?.round === host.state.roundNumber) return
    const entry = previous ?? { round: 0, active: [], previous: [], total: 0 }
    entry.previous = [...entry.active]
    entry.active = []
    entry.round = host.state.roundNumber
    table[ownerId] = entry
    const remaining = Math.max(0, 4 - entry.total)
    if (!remaining) return
    const names = [...new Set(Object.values(host.state.cards)
      .filter((card) => !card.virtual)
      .map((card) => card.name))]
      .filter((name) => !entry.previous.includes(name))
    if (!names.length) return
    host.askSkill({ skillId: MZ_KAN, ownerId, step: 'record', data: { round: host.state.roundNumber }, build: (id): ChooseOptionsRequest => ({
      id, kind: 'choose-options', playerId: ownerId, prompt: '【看破】：选择本轮要记录的牌名（可不选）',
      timeoutMs: 25_000, optional: true,
      options: names.map((name) => ({ id: name, label: name })), min: 0, max: Math.min(remaining, names.length),
    }) })
    } },
    { event: 'BeforeCardUse', handle(host, _ownerId, context) {
      const state = host.state as Batch53State
      const pending = state.b53MouZhugeKanpoPlay
      if (!pending || pending.cancelled || context.event.payload.cardId !== pending.cardId) return
      context.cancel()
      pending.cancelled = true
    } },
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const cardId = context.event.payload.cardId
      const state = host.state as Batch53State
      const pending = state.b53MouZhugeKanpoPlay
      if (pending && pending.cardId === cardId && pending.cancelled) return
      state.b53MouZhugeKanpoDeclined = (state.b53MouZhugeKanpoDeclined ?? []).filter((declined) => declined.cardId !== cardId)
    } },
    { event: 'CardResolved', handle(host, _ownerId, context) {
      const state = host.state as Batch53State
      const pending = state.b53MouZhugeKanpoPlay
      if (!pending || !pending.cancelled || context.event.payload.cardId !== pending.cardId) return
      const resolved = pending
      state.b53MouZhugeKanpoPlay = null
      state.b53MouZhugeKanpoDeclined = (state.b53MouZhugeKanpoDeclined ?? []).filter((declined) => declined.cardId !== resolved.cardId)
      drawCards(host.state, host.rng, resolved.ownerId, 1, (name, payload) => host.dispatch(name, payload))
      host.dispatch('SkillActivated', {
        skillId: MZ_KAN, skillName: '看破', playerId: resolved.ownerId, targetIds: [resolved.sourceId],
        result: 'card-invalidated', logText: `【看破】移去“${resolved.cardName}”记录，令此牌无效并摸一张牌`,
      }, { sourceId: resolved.ownerId, targetId: resolved.sourceId, cardIds: [resolved.cardId] })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'record') {
      const entry = (host.state as Batch53State).b53MouZhugeKanpo?.[ownerId]
      const optionIds = (response.payload as { optionIds?: string[] }).optionIds ?? []
      if (!entry || resolution.data.round !== host.state.roundNumber || entry.round !== host.state.roundNumber) return
      const names = [...new Set(optionIds)].filter((name) => !entry.previous.includes(name))
        .slice(0, Math.max(0, 4 - entry.total))
      entry.active = names
      entry.total += names.length
      return
    }
    if (resolution.step === 'play-intercept') {
      const action = resolution.data.action as LegalAction
      if (action.kind !== 'use-card') return
      const cardName = resolution.data.cardName as string
      const state = host.state as Batch53State
      const accepted = (response.payload as { optionId?: string }).optionId === 'yes'
      if (accepted) {
        const entry = state.b53MouZhugeKanpo?.[ownerId]
        const index = entry?.active.indexOf(cardName) ?? -1
        if (index >= 0) entry!.active.splice(index, 1)
        state.b53MouZhugeKanpoPlay = {
          ownerId, sourceId: action.playerId, cardId: action.cardIds[0], cardName,
          actionId: action.id, cancelled: false,
        }
      } else {
        state.b53MouZhugeKanpoDeclined ??= []
        if (!state.b53MouZhugeKanpoDeclined.some((declined) => declined.actionId === action.id)) {
          state.b53MouZhugeKanpoDeclined.push({ actionId: action.id, cardId: action.cardIds[0] })
        }
      }
      executeUseCardAction(host as never, action.playerId, action)
      return
    }
    if (resolution.step !== 'intercept') return
    const targetId = resolution.data.targetId as PlayerId
    const cardName = resolution.data.cardName as string
    if ((response.payload as { optionId?: string }).optionId === 'yes') {
      const entry = (host.state as Batch53State).b53MouZhugeKanpo?.[ownerId]
      const index = entry?.active.indexOf(cardName) ?? -1
      if (index >= 0) entry!.active.splice(index, 1)
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      const current = host.state.cardResolution
      if (current?.kind === 'trick') {
        for (const id of current.targetIds) if (!current.nullifiedTargetIds.includes(id)) current.nullifiedTargetIds.push(id)
      } else if (current?.kind === 'slash' && current.targetId === targetId) {
        current.targetCancelled = true
        current.remainingTargetIds = []
      }
      host.dispatch('SkillActivated', {
        skillId: MZ_KAN, skillName: '看破', playerId: ownerId, targetIds: [targetId],
        result: 'card-invalidated', logText: `【看破】移去“${cardName}”记录，令此牌无效并摸一张牌`,
      }, { sourceId: ownerId, targetId })
    }
    host.resumeCardTarget()
  },
})

// 【观星※】：星牌是真实牌，既留在武将牌上，也通过通用转化/响应入口作为本人手牌使用。
registerSkillRuntime({ id: MZ_STAR,
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = state.players.find((candidate) => candidate.id === ownerId)
    if (!owner?.alive) return []
    return (owner.characterPiles.star ?? []).flatMap((cardId) => {
      const card = state.cards[cardId]
      return card ? [{ asCardName: card.name, cardId, label: `将“星”牌【${card.name}】作为手牌使用或打出` }] : []
    })
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    if (phase.playerId !== ownerId || !player(host, ownerId)?.alive) return
    const state = host.state as Batch53State
    if (state.b53MouZhugeStarGrantedTurn?.[ownerId] === host.state.turnNumber) return
    if (phase.phase === 'prepare') {
      state.b53MouZhugeStarTopped ??= {}
      state.b53MouZhugeStarTopped[ownerId] = false
      const oldStars = [...(player(host, ownerId)?.characterPiles.star ?? [])]
      for (const cardId of oldStars) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: 'star' }, { kind: 'discardPile' })
      const previous = state.b53MouZhugeStarPrepares?.[ownerId] ?? 0
      const count = Math.max(0, 7 - previous * 3)
      state.b53MouZhugeStarPrepares ??= {}
      state.b53MouZhugeStarPrepares[ownerId] = previous + 1
      const revealed = revealTopCards(host.state, host.rng, count, MZ_STAR, (name, payload) => host.dispatch(name, payload))
      for (const cardId of revealed) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'characterPile', playerId: ownerId, pile: 'star' })
      const stars = [...(player(host, ownerId)?.characterPiles.star ?? [])]
      if (stars.length) askCards(host, MZ_STAR, ownerId, 'prepare-top', ownerId, stars, 0, stars.length,
        '【观星※】：可将任意张“星”牌置于牌堆顶', {}, true)
      return
    }
    if (phase.phase === 'finish' && !state.b53MouZhugeStarTopped?.[ownerId]) {
      const stars = [...(player(host, ownerId)?.characterPiles.star ?? [])]
      if (stars.length) askCards(host, MZ_STAR, ownerId, 'finish-top', ownerId, stars, 0, stars.length,
        '【观星※】：可将任意张“星”牌置于牌堆顶', {}, true)
    }
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'prepare-top' && resolution.step !== 'finish-top') return
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = player(host, ownerId)
    if (!owner?.alive) return
    const valid = selected.filter((cardId) => owner.characterPiles.star?.includes(cardId))
    for (const cardId of [...valid].reverse())
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: 'star' }, { kind: 'drawPile' }, { toTop: true })
    if (resolution.step === 'prepare-top' && valid.length)
      ((host.state as Batch53State).b53MouZhugeStarTopped ??= {})[ownerId] = true
  },
})

registerJudgmentContinuation(MZ_EMPTY_JUDGE, (host, judged, data) => {
  const game = host as SkillHost
  const targetId = data.targetId as PlayerId
  const target = player(host, targetId)
  const pending = host.state.pendingDamageModifier
  if (!target?.alive || pending?.skillId !== MZ_EMPTY) {
    if (pending?.skillId === MZ_EMPTY) host.state.pendingDamageModifier = undefined
    host.resumeAfterDying()
    return
  }
  host.state.pendingDamageModifier = undefined
  const starCount = target.characterPiles.star?.length ?? 0
  const amount = Math.max(0, Number(data.amount ?? 0) - (judged.rank <= starCount ? 1 : 0))
  if (amount === 0) {
    host.dispatch('SkillActivated', {
      skillId: MZ_EMPTY, skillName: '空城※', playerId: targetId, result: 'damage-modified',
      logText: `【空城※】判定点数${judged.rank}不大于“星”数${starCount}，将此伤害减至0`,
    }, { targetId, damageNature: data.nature as DamageNature })
  } else {
    if (amount !== Number(data.amount)) host.dispatch('SkillActivated', {
      skillId: MZ_EMPTY, skillName: '空城※', playerId: targetId, result: 'damage-modified',
      logText: `【空城※】判定点数${judged.rank}不大于“星”数${starCount}，此伤害-1`,
    }, { targetId, damageNature: data.nature as DamageNature })
    finalizeDamage(game as never, target, data.sourceId as PlayerId | null, amount,
      data.nature as DamageNature, data.cardId as CardId | null, data.cardName as string | null,
      data.redirectedBy as string | null, Boolean(data.chainTransfer))
  }
  host.resumeAfterDying()
})

registerSkillRuntime({ id: MZ_EMPTY,
  triggers: [{ event: 'BeforeDamage', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId) return
    const owner = player(host, ownerId)
    if (!owner?.alive) return
    const stars = owner.characterPiles.star ?? []
    const payload = context.event.payload as { amount?: number; cardId?: CardId | null; cardName?: string | null; redirectedBy?: string | null; chainTransfer?: boolean }
    const originalAmount = Number(payload.amount ?? 0)
    if (originalAmount <= 0) return
    if (stars.length === 0) {
      payload.amount = originalAmount + 1
      host.dispatch('SkillActivated', {
        skillId: MZ_EMPTY, skillName: '空城※', playerId: ownerId, result: 'damage-modified',
        logText: '【空城※】武将牌上没有“星”，此伤害+1',
      }, { targetId: ownerId, damageNature: context.event.damageNature })
      return
    }
    // 一个角色一次只能挂起一笔互动伤害；已有判定时复用该判定，不能覆写其续接。
    if (host.state.pendingDamageModifier || host.state.retrial) return
    context.cancel()
    const damage = {
      targetId: ownerId,
      sourceId: context.event.sourceId ?? null,
      amount: originalAmount,
      nature: context.event.damageNature ?? 'normal',
      cardId: payload.cardId ?? null,
      cardName: payload.cardName ?? null,
      redirectedBy: payload.redirectedBy ?? null,
      chainTransfer: Boolean(payload.chainTransfer),
    }
    host.state.pendingDamageModifier = { side: 'target', skillId: MZ_EMPTY, options: damage }
    performJudgment(host as never, ownerId, '空城', { tag: MZ_EMPTY_JUDGE, data: damage })
  } }],
})

registerGroupDecision(ZY_WU_TAG, (groupHost: GroupDecisionHost, decision: GroupDecisionState) => {
  const host = groupHost as unknown as SkillHost
  const [ownerId, targetId] = decision.playerIds
  if (!ownerId || !targetId || !player(host, ownerId)?.alive || !player(host, targetId)?.alive) return
  const ownerDecision = decision.responses[ownerId]
  const targetDecision = decision.responses[targetId]
  if (ownerDecision === 'A' && targetDecision === 'A') {
    resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: '怃戎' })
    if (player(host, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
  } else if (ownerDecision === 'A' && targetDecision === 'B') {
    const pickable = pickableCardsOf(host.state, targetId)
    if (pickable.cardIds.length + pickable.hiddenCardSlots.length) {
      host.askSkill({ skillId: ZY_WU, ownerId, step: 'take', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【怃戎】：选择获得目标的一张牌', timeoutMs: 30_000,
        optional: false, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
      }) })
    }
  } else if (ownerDecision === 'B' && targetDecision === 'A') {
    loseHp(host as never, ownerId, 1, ZY_WU)
    if (player(host, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
  } else {
    const target = player(host, targetId)!
    const cards = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
    if (cards.length < 2) schedulePhaseSkipForPlayer(host.state, targetId, 'draw')
    else host.askSkill({ skillId: ZY_WU, ownerId, step: 'submit', data: { targetId }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: targetId, prompt: '【怃戎】：选择交给张嶷的两张牌', timeoutMs: 30_000,
      optional: false, purpose: 'skill', cardIds: Object.values(target.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)),
      hiddenCardSlots: pickableCardsOf(host.state, targetId).hiddenCardSlots, min: 2, max: 2,
    }) })
  }
})

registerSkillRuntime({ id: ZY_WU,
  activeActions(state, ownerId) {
    const owner = state.players.find((p) => p.id === ownerId)
    if (!owner?.alive || owner.characterId !== JIE_ZHANGYI.id || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, ZY_WU) || !state.players.some((p) => p.alive && p.id !== ownerId)) return []
    return [{ id: `skill:${ZY_WU}`, label: '怃戎：与一名其他角色同时谋弈' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${ZY_WU}` || usedThisPhase(host.state, ownerId, ZY_WU)) return
    const candidates = others(host, ownerId).map((p) => p.id)
    if (candidates.length) askTargets(host, ZY_WU, ownerId, 'target', '【怃戎】：选择一名其他角色进行同时谋弈', candidates)
  },
  resume(host, ownerId, resolution, response) {
    const targetId = (resolution.data as { targetId?: PlayerId }).targetId
    if (resolution.step === 'target') {
      const selected = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!selected || !player(host, selected)?.alive) return
      markUsedThisPhase(host.state, ownerId, ZY_WU)
      startGroupDecision(host, { id: `${ZY_WU}:${host.state.seq}`, tag: ZY_WU_TAG, skillId: ZY_WU,
        playerIds: [ownerId, selected], prompt: '【怃戎·谋弈】：双方同时秘密选择一项',
        options: [{ id: 'A', label: '选择一' }, { id: 'B', label: '选择二' }], defaultOptionId: 'A', timeoutMs: 30_000,
        optionsFor: (playerId) => playerId === ownerId
          ? [{ id: 'A', label: '镇压' }, { id: 'B', label: '安抚' }]
          : [{ id: 'A', label: '反抗' }, { id: 'B', label: '归顺' }],
      })
      return
    }
    if (resolution.step === 'take' && targetId && player(host, targetId)?.alive) {
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = picked ? resolvePickedCard(host.state, targetId, picked) : null
      if (cardId && movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) {
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: ZY_WU }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZY_WU }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      }
      const owner = player(host, ownerId)
      const count = Math.min(2, owner?.zones.hand.length ?? 0)
      if (owner && count) askCards(host, ZY_WU, ownerId, 'give', ownerId, [...owner.zones.hand], count, count,
        `【怃戎】：交给其${count}张手牌`, { targetId }, false)
      return
    }
    if (resolution.step === 'give' && targetId && player(host, targetId)?.alive) {
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (ids.length === 2 && ids.every((id) => player(host, ownerId)?.zones.hand.includes(id)))
        giveCards(host as never, ownerId, targetId, ids, ZY_WU)
      return
    }
    if (resolution.step === 'submit' && targetId && player(host, targetId)?.alive) {
      const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const resolved = selected.map((picked) => resolvePickedCard(host.state, targetId, picked)).filter((id): id is CardId => Boolean(id))
      for (const cardId of resolved) {
        const from = locateOwnedCard(host.state, targetId, cardId)
        if (!from || !movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) continue
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: ZY_WU }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZY_WU }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      }
    }
  },
})

registerSkillRuntime({ id: ZY_SHI, forcedCardIdentity(state, ownerId, cardId) {
  const owner = player({ state } as SkillHost, ownerId)
  if (!owner?.alive || owner.hp !== 1 || state.cards[cardId]?.name !== '闪') return null
  return { asCardName: '杀', nature: 'normal' }
} })

registerSkillRuntime({ id: GY_WU,
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = state.players.find((p) => p.id === ownerId)
    if (!owner?.alive || owner.characterId !== MOU_GUANYU.id) return []
    return owner.zones.hand.flatMap((cardId) => {
      const card = state.cards[cardId]
      return card && card.name !== '杀' ? [{ asCardName: '杀', cardId, label: `将【${card.name}】当【杀】使用或打出` }] : []
    })
  },
  ignoresSlashUsesTo(state, ownerId, targetId) {
    const current = (state as Batch53State).b53GuanyuTarget?.[ownerId]
    const count = (state as Batch53State).b53TargetBan?.[ownerId]
    return current?.turn === state.turnNumber && current.targetId === targetId && current.slashes < 3
      && !(count?.turn === state.turnNumber && count.targetIds.includes(targetId))
  },
  ignoresDistanceTo(state, ownerId, targetId) {
    const current = (state as Batch53State).b53GuanyuTarget?.[ownerId]
    const count = (state as Batch53State).b53TargetBan?.[ownerId]
    return current?.turn === state.turnNumber && current.targetId === targetId && current.slashes < 3
      && !(count?.turn === state.turnNumber && count.targetIds.includes(targetId))
  },
  prohibitsSourceTarget(state, ownerId, targetId, cardName) {
    const current = (state as Batch53State).b53GuanyuTarget?.[ownerId]
    return cardName === '杀' && current?.turn === state.turnNumber && current.targetId === targetId && current.slashes >= 3
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (phase.playerId !== ownerId || phase.phase !== 'play' || !player(host, ownerId)?.alive) return
      const candidates = host.state.players.filter((p) => p.alive && p.id !== ownerId && p.identity !== 'lord').map((p) => p.id)
      if (candidates.length) askTargets(host, GY_WU, ownerId, 'target', '【武圣】：选择本出牌阶段的指定角色（非主公）', candidates)
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardName?: string; targetIds?: PlayerId[] }
      const targetId = (host.state as Batch53State).b53GuanyuTarget?.[ownerId]
      if (payload.cardName !== '杀' || targetId?.turn !== host.state.turnNumber || !payload.targetIds?.includes(targetId.targetId)) return
      targetId.slashes++
      const lordField = host.state.players.some((p) => p.identity === 'lord')
      drawCards(host.state, host.rng, ownerId, lordField ? 2 : 1, (name, data) => host.dispatch(name, data))
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? player(host, targetId) : undefined
    if (!target?.alive || target.identity === 'lord') return
    ;((host.state as Batch53State).b53GuanyuTarget ??= {})[ownerId] = { turn: host.state.turnNumber, targetId: target.id, slashes: 0 }
  },
})

registerSkillRuntime({ id: GY_YI,
  prohibitsSourceTarget(state, ownerId, targetId) {
    const ban = (state as Batch53State).b53TargetBan?.[ownerId]
    return ban?.turn === state.turnNumber && ban.targetIds.includes(targetId)
  },
  triggers: [{ event: 'SkillActivated', handle(host, ownerId, context) {
    const payload = context.event.payload as { skillId?: string; result?: string; playerId?: PlayerId }
    if (payload.skillId !== GY_YI || payload.result !== 'damage-prevented' || payload.playerId !== ownerId) return
    const targetId = context.event.targetId
    if (!targetId || targetId === ownerId) return
    const used = (host.state as Batch53State).b53YiJueUsed ??= {}
    const targets = used[ownerId] ??= []
    if (!targets.includes(targetId)) targets.push(targetId)
    const ban = (host.state as Batch53State).b53TargetBan ??= {}
    const entry = ban[ownerId]?.turn === host.state.turnNumber ? ban[ownerId]! : { turn: host.state.turnNumber, targetIds: [] }
    if (!entry.targetIds.includes(targetId)) entry.targetIds.push(targetId)
    ban[ownerId] = entry
  } }],
  preventsFinalDamage(state, ownerId, context) {
    if (context.sourceId !== ownerId || context.targetId === ownerId || state.currentPlayerId !== ownerId || context.amount <= 0
      || state.dying?.playerId === context.targetId
      || context.amount < (state.players.find((p) => p.id === context.targetId)?.hp ?? Infinity)) return false
    return !(state as Batch53State).b53YiJueUsed?.[ownerId]?.includes(context.targetId)
  },
})

registerSkillRuntime({ id: HG_ZHA,
  unlimitedSlashFor(state, ownerId, cardId) {
    return zhaxiangUnlimited(state, ownerId, cardId)
  },
  slashIgnoresDistance(state, ownerId, cardId) {
    return zhaxiangUnlimited(state, ownerId, cardId)
  },
  ignoresTrickDistance(state, ownerId) {
    const cardId = state.cardResolution?.cardId
    return zhaxiangUnlimited(state, ownerId, cardId)
  },
  slashUndodgeable(state, _ownerId, _targetId, cardId) {
    return Boolean(cardId && (state as Batch53State).b53FreeCards?.includes(cardId))
  },
  trickUnresponsive(state, _ownerId, _targetId, _cardName, cardId) {
    return Boolean(cardId && (state as Batch53State).b53FreeCards?.includes(cardId))
  },
  cannotBeNullified(state, _ownerId) {
    const id = state.cardResolution?.cardId
    return Boolean(id && (state as Batch53State).b53FreeCards?.includes(id))
  },
  triggers: [{ event: 'DrawPhase', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; count?: number }
    if (payload.playerId !== ownerId) return
    const owner = player(host, ownerId)
    if (!owner?.alive) return
    payload.count = Number(payload.count ?? 2) + Math.max(0, owner.maxHp - owner.hp)
  } }, { event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const record = (host.state as Batch53State).b53ShaCount ??= {}
    const previous = record[ownerId]
    const count = previous?.turn === host.state.turnNumber ? previous.count : 0
    const x = Math.max(0, (player(host, ownerId)?.maxHp ?? 0) - (player(host, ownerId)?.hp ?? 0))
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (cardId && x > count) ((host.state as Batch53State).b53FreeCards ??= []).push(cardId)
    record[ownerId] = { turn: host.state.turnNumber, count: count + 1 }
  } }, { event: 'TurnStart', handle(host, ownerId) {
    delete (host.state as Batch53State).b53ShaCount?.[ownerId]
    const state = host.state as Batch53State
    state.b53FreeCards = (state.b53FreeCards ?? []).filter((id) => state.cardResolution?.cardId === id)
  } }],
})

function zhaxiangUnlimited(state: SanguoshaState, ownerId: PlayerId, cardId?: CardId): boolean {
  const b53 = state as Batch53State
  if (cardId && b53.b53FreeCards?.includes(cardId)) return true
  const owner = state.players.find((p) => p.id === ownerId)
  const x = Math.max(0, (owner?.maxHp ?? 0) - (owner?.hp ?? 0))
  const mark = b53.b53ShaCount?.[ownerId]
  return x > 0 && (!mark || mark.turn !== state.turnNumber || mark.count < x)
}

registerSkillRuntime({ id: SQ_ZHI,
  activeActions(state, ownerId) {
    const owner = state.players.find((p) => p.id === ownerId)
    if (!owner?.alive || owner.characterId !== MOU_SUNQUAN.id || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, SQ_ZHI)) return []
    return [{ id: `skill:${SQ_ZHI}`, label: '制衡：弃置任意张牌，然后摸等量牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${SQ_ZHI}`) return
    const owner = player(host, ownerId)
    if (!owner?.alive) return
    const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    host.askSkill({ skillId: SQ_ZHI, ownerId, step: 'discard', data: { handCount: owner.zones.hand.length }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【制衡】：选择任意张牌弃置',
      timeoutMs: 30_000, optional: true, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 0, max: cards.length,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = player(host, ownerId)
    if (!owner?.alive || ids.some((id) => !locateOwnedCard(host.state, ownerId, id))) return
    const handCount = (resolution.data as { handCount?: number }).handCount ?? 0
    const emptiedHand = handCount > 0 && ids.filter((id) => owner.zones.hand.includes(id)).length === handCount
    const discarded = discard(host, ownerId, ids, SQ_ZHI)
    if (discarded.length !== ids.length) return
    markUsedThisPhase(host.state, ownerId, SQ_ZHI)
    drawCards(host.state, host.rng, ownerId, discarded.length + (emptiedHand ? (owner.marks.b53Ye ?? 0) + 1 : 0), (name, payload) => host.dispatch(name, payload))
    if (emptiedHand && (owner.marks.b53Ye ?? 0) > 0) owner.marks.b53Ye!--
  },
})

function equipmentCount(state: SanguoshaState): number {
  return state.players.reduce((sum, p) => sum + Object.values(p.zones.equipment).filter(Boolean).length, 0)
}
registerSkillRuntime({ id: SQ_TONG,
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    if (phase.playerId !== ownerId || phase.phase !== 'finish' || !player(host, ownerId)?.alive) return
    const count = equipmentCount(host.state)
    askOption(host, SQ_TONG, ownerId, 'predict', ownerId, '【统业】：选择对下一回合结束时的场上装备数变化进行预测', [
      { id: 'changed', label: '预测装备数会变化；变化则获得“业”，不变则失去“业”' },
      { id: 'same', label: '预测装备数不变；不变则获得“业”，变化则失去“业”' },
    ], { count }, false)
  } }, { event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    const state = host.state as Batch53State
    const pending = state.b53EquipPrediction?.[ownerId]
    if (phase.playerId !== ownerId || phase.phase !== 'prepare' || !pending || pending.turn >= host.state.turnNumber) return
    const changed = equipmentCount(host.state) !== pending.count
    const correct = pending.mode === (changed ? 'changed' : 'same')
    const owner = player(host, ownerId)
    if (owner) owner.marks.b53Ye = Math.max(0, Math.min(2, (owner.marks.b53Ye ?? 0) + (correct ? 1 : -1)))
    delete state.b53EquipPrediction?.[ownerId]
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'predict') return
    const mode = (response.payload as { optionId?: string }).optionId
    if (mode !== 'changed' && mode !== 'same') return
    ;((host.state as Batch53State).b53EquipPrediction ??= {})[ownerId] = { mode, count: (resolution.data as { count: number }).count, turn: host.state.turnNumber }
  },
})
registerSkillRuntime({ id: SQ_JIU, lord: true,
  rescueRecoverBonus(state, ownerId, responderId) {
    const ruler = state.players.find((p) => p.id === ownerId)
    const helper = state.players.find((p) => p.id === responderId)
    return ruler?.alive && ruler.identity === 'lord' && helper?.alive && helper.id !== ownerId && effectiveKingdomOf(state, helper.id) === 'wu' ? 1 : 0
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    const ruler = player(host, ownerId)
    const source = context.event.sourceId ? player(host, context.event.sourceId) : undefined
    if (ruler?.alive && ruler.identity === 'lord' && source?.alive && effectiveKingdomOf(host.state, source.id) === 'wu'
      && (context.event.payload as { cardName?: string }).cardName === '桃')
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
  } }],
})

// “逆取”是动态结党可能授予的常侍技能：不限目标阵营，可选择任意存活角色（包括自己）。
registerPindianContinuation(SS_YAOZHUO_PINDIAN, (rawHost, result) => {
  const host = rawHost as unknown as SkillHost
  const ownerId = result.initiatorId
  if (result.outcome === 'initiator-win') {
    schedulePhaseSkipForPlayer(host.state, result.opponentId, 'draw')
    return
  }
  const owner = player(host, ownerId)
  if (!owner?.alive) return
  const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
  const count = Math.min(2, cards.length)
  if (!count) return
  askCards(host, SS_YAOZHUO, ownerId, 'penalty', ownerId, cards, count, count,
    '【谣诼】：拼点未赢，弃置两张牌（不足两张则弃置全部）', {}, false)
})

registerSkillRuntime({ id: SS_YAOZHUO,
  activeActions(state, ownerId) {
    const owner = state.players.find((candidate) => candidate.id === ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, SS_YAOZHUO)
      || !canPindian(state, ownerId)) return []
    return state.players.some((target) => target.alive && target.id !== ownerId && target.hp <= owner.hp && canPindian(state, target.id))
      ? [{ id: `skill:${SS_YAOZHUO}`, label: '谣诼：与一名体力值不大于你的角色拼点' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${SS_YAOZHUO}` || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || usedThisPhase(host.state, ownerId, SS_YAOZHUO) || !canPindian(host.state, ownerId)) return
    const owner = player(host, ownerId)
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId
      && target.hp <= (owner?.hp ?? -1) && canPindian(host.state, target.id)).map((target) => target.id)
    if (candidates.length) askTargets(host, SS_YAOZHUO, ownerId, 'target', '【谣诼】：选择一名体力值不大于你的角色拼点', candidates)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = player(host, ownerId)
      const target = targetId ? player(host, targetId) : undefined
      if (!owner?.alive || !target?.alive || target.id === ownerId || target.hp > owner.hp
        || !canPindian(host.state, ownerId) || !canPindian(host.state, target.id)) return
      markUsedThisPhase(host.state, ownerId, SS_YAOZHUO)
      startPindian(host as never, { id: `${SS_YAOZHUO}:${host.state.seq}`, initiatorId: ownerId, opponentId: target.id,
        reason: SS_YAOZHUO, continuationTag: SS_YAOZHUO_PINDIAN })
      return
    }
    if (resolution.step !== 'penalty') return
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = player(host, ownerId)
    const legal = new Set(owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : [])
    if (!owner || selected.length !== Math.min(2, legal.size) || selected.some((id) => !legal.has(id))) return
    const discarded: CardId[] = []
    for (const cardId of selected) if (movePickedCard(host as never, ownerId, cardId, { kind: 'discardPile' })) discarded.push(cardId)
    if (discarded.length) host.dispatch('LoseCard', { playerId: ownerId, cardIds: discarded, reason: SS_YAOZHUO }, { sourceId: ownerId, cardIds: discarded })
  },
})

registerSkillRuntime({ id: SS_DANG,
  triggers: [{ event: 'RestEnd', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
    ;((host.state as Batch53State).b53RestReturned ??= {})[ownerId] = true
    host.queueSkill({ skillId: SS_DANG, ownerId, step: 'rejoin-party', data: {} })
  } }],
  onGameStart(host, ownerId) {
    const state = host.state as Batch53State
    state.b53Attendants ??= {}
    if (state.b53Attendants[ownerId]) return
    state.b53Attendants[ownerId] = { revealed: [], records: randomShichangshiRecords(host) }
    beginShichangshiParty(host, ownerId, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'rejoin-party') {
      beginShichangshiParty(host, ownerId, true)
      return
    }
    if (resolution.step !== 'partner') return
    const data = resolution.data as { candidateIds?: string[]; returning?: boolean }
    const candidateId = (response.payload as { optionId?: string }).optionId
    if (!candidateId || !data.candidateIds?.includes(candidateId)) return
    completeShichangshiParty(host, ownerId, candidateId, data.returning === true)
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'rejoin-party') beginShichangshiParty(host, ownerId, true)
  },
})

registerSkillRuntime({ id: SS_MOW,
  triggers: [
    { event: 'BeforeDeath', priority: -100, handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const owner = player(host, ownerId)
      const attendants = (host.state as Batch53State).b53Attendants?.[ownerId]
      if (!owner?.alive || owner.maxHp <= 0 || !attendants) return
      const remaining = SHICHANGSHI_CARDS.some((card) => !attendants.revealed.includes(card.id))
      if (remaining) owner.restingUntilRound = host.state.roundNumber + 1
    } },
    { event: 'TurnEnd', priority: -100, handle(host, ownerId, context) {
      const state = host.state as Batch53State
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId || !player(host, ownerId)?.alive
        || !state.b53RestReturned?.[ownerId]) return
      delete state.b53RestReturned[ownerId]
      forceDeath(host as never, ownerId)
    } },
  ],
})

// 张让【滔乱】：只在自己的出牌阶段提供基本牌/普通锦囊转化，并且每阶段限一次。
const TAOLUAN_NAMES = ['杀', '闪', '桃', '酒', '无中生有', '过河拆桥', '顺手牵羊', '决斗', '南蛮入侵', '万箭齐发', '桃园结义', '五谷丰登', '无懈可击', '火攻', '铁索连环', '借刀杀人', '奇正相生']
registerSkillRuntime({ id: SS_TAOLUAN,
  viewAs(state, ownerId) {
    const owner = state.players.find((candidate) => candidate.id === ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, SS_TAOLUAN)) return []
    const ownedCards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    return ownedCards.flatMap((cardId) => {
      const realName = state.cards[cardId]?.name
      if (!realName) return []
      return TAOLUAN_NAMES.filter((name) => name !== realName).map((asCardName) => ({ asCardName, cardId, label: `滔乱：将【${realName}】当【${asCardName}】使用` }))
    })
  },
  triggers: [{ event: 'BeforeCardUse', handle(host, ownerId, context) {
    if (context.event.sourceId === ownerId && host.state.phase === 'play' && host.state.currentPlayerId === ownerId
      && context.event.sourceSkillId === SS_TAOLUAN) markUsedThisPhase(host.state, ownerId, SS_TAOLUAN)
  } }],
})

// 赵忠【鸱咽】：选中的牌进入公共“本回合结束归还”区，装备离场与死亡清理沿用引擎规则。
registerSkillRuntime({ id: SS_CHIYAN,
  triggers: [{ event: 'TargetSpecified', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
    if (context.event.sourceId !== ownerId || payload.cardName !== '杀' || !payload.cardId) return
    for (const targetId of payload.targetIds ?? []) {
      if (!player(host, targetId)?.alive) continue
      askOption(host, SS_CHIYAN, ownerId, `invoke:${payload.cardId}:${targetId}`, ownerId,
        '【鸱咽】：是否将此目标至多两张牌扣置至本回合结束？',
        [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], { cardId: payload.cardId, targetId })
    }
  } }],
  outgoingDamage(state, ownerId, context) {
    const source = state.players.find((candidate) => candidate.id === ownerId)
    const target = state.players.find((candidate) => candidate.id === context.targetId)
    return context.cardName === '杀' && context.cardId && source && target
      && source.zones.hand.length >= target.zones.hand.length
      && Object.values(source.zones.equipment).filter(Boolean).length >= Object.values(target.zones.equipment).filter(Boolean).length
      ? { amount: context.amount + 1 } : null
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step.startsWith('invoke:')) {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = (resolution.data as { targetId?: PlayerId }).targetId
      const target = targetId ? player(host, targetId) : undefined
      if (!targetId || !target?.alive) return
      const pickable = pickableCardsOf(host.state, targetId)
      const count = Math.min(2, pickable.cardIds.length + pickable.hiddenCardSlots.length)
      if (count) host.askSkill({ skillId: SS_CHIYAN, ownerId, step: `seize:${targetId}`, data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【鸱咽】：选择目标至多两张牌扣置至当前回合结束',
        timeoutMs: 30_000, optional: false, purpose: 'skill', cardIds: pickable.cardIds,
        hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: count,
      }) })
      return
    }
    if (!resolution.step.startsWith('seize:')) return
    const targetId = (resolution.data as { targetId?: PlayerId }).targetId
    const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
    const target = targetId ? player(host, targetId) : undefined
    const cardIds = target?.alive ? selected.map((picked) => resolvePickedCard(host.state, target.id, picked)).filter((id): id is CardId => Boolean(id)) : []
    if (!targetId || cardIds.length !== selected.length || cardIds.length < 1 || cardIds.length > 2) return
    detainCards(host as never, { ownerId: targetId, sourceId: ownerId, skillId: SS_CHIYAN, cardIds })
  },
})

// 段珪【叱吓】：记录当前唯一目标的禁响应花色，并将本次【杀】的伤害增量绑定到 CardId。
registerSkillRuntime({ id: SS_CHIXIA,
  triggers: [{ event: 'TargetSpecified', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
    if (context.event.sourceId !== ownerId || payload.cardName !== '杀' || !payload.cardId || payload.targetIds?.length !== 1) return
    const targetId = payload.targetIds[0]!
    if (!player(host, targetId)?.alive) return
    askOption(host, SS_CHIXIA, ownerId, `invoke:${payload.cardId}`, ownerId, '【叱吓】：是否亮出牌堆顶两张牌强化此【杀】？',
      [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], { cardId: payload.cardId, targetId })
  } }, { event: 'CardResolved', handle(host, _ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const effects = (host.state as Batch53State).b53ShichangshiChixia
    const effect = cardId ? effects?.[cardId] : undefined
    if (cardId && effect) {
      delete effects?.[cardId]
    }
  } }],
  resume(host, ownerId, resolution, response) {
    if (!resolution.step.startsWith('invoke:') || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const { cardId, targetId } = resolution.data as { cardId?: CardId; targetId?: PlayerId }
    const slash = cardId ? host.state.cards[cardId] : undefined
    if (!cardId || !slash || !targetId || !player(host, targetId)?.alive) return
    const cards = revealTopCards(host.state, host.rng, 2, SS_CHIXIA, (name, payload) => host.dispatch(name, payload))
    const suits = [...new Set(cards.map((id) => host.state.cards[id]?.suit).filter((suit): suit is NonNullable<typeof suit> => Boolean(suit)))]
    const slashSuit = effectiveCardSuit(host.state, ownerId, cardId)
    const bonus = cards.filter((id) => host.state.cards[id]?.suit === slashSuit).length
    ;((host.state as Batch53State).b53ShichangshiChixia ??= {})[cardId] = { ownerId, targetId, suits, bonus }
    for (const id of cards) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'discardPile' })
  },
  outgoingDamage(state, ownerId, context) {
    const effect = context.cardId ? (state as Batch53State).b53ShichangshiChixia?.[context.cardId] : undefined
    return effect?.ownerId === ownerId && effect.targetId === context.targetId && context.cardName === '杀' && effect.bonus > 0
      ? { amount: context.amount + effect.bonus } : null
  },
  prohibitsResponseCard(state, ownerId, responderId, responseCardId) {
    const effect = Object.values((state as Batch53State).b53ShichangshiChixia ?? {})
      .find((entry) => entry.ownerId === ownerId && entry.targetId === responderId)
    return Boolean(effect && effect.suits.includes(effectiveCardSuit(state, responderId, responseCardId)))
  },
})

// 高望【妙语】：单牌转化与“双牌同花色”复合转化共用牌名映射；双牌附加效果绑定实体载体直到结算。
const MIAOYU_CARD_BY_SUIT = { heart: '桃', diamond: '杀', club: '闪', spade: '无懈可击' } as const
registerSkillRuntime({ id: SS_MIAOYU,
  viewAs(state, ownerId) {
    const owner = state.players.find((candidate) => candidate.id === ownerId)
    if (!owner?.alive) return []
    const ownedCards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    return ownedCards.flatMap((cardId) => {
      const suit = effectiveCardSuit(state, ownerId, cardId)
      const asCardName = MIAOYU_CARD_BY_SUIT[suit]
      return [{ asCardName, cardId, ...(suit === 'diamond' ? { nature: 'fire' as const } : {}), label: `妙语：将一张牌当【${suit === 'diamond' ? '火杀' : asCardName}】使用或打出` }]
    })
  },
  multiCardViewAs(state, ownerId) {
    const owner = state.players.find((candidate) => candidate.id === ownerId)
    if (!owner?.alive) return null
    return {
      skillId: SS_MIAOYU, skillName: '妙语', requiredCount: 2,
      suitToCardName: MIAOYU_CARD_BY_SUIT, natureOf: { diamond: 'fire' },
      onConvert(batchState, playerId, carrierId, cardIds, asCardName) {
        if (!batchState.cards[carrierId]) return
        const colors = [...new Set(cardIds.map((id) => effectiveCardColor(batchState, playerId, id)))]
        ;((batchState as Batch53State).b53MiaoyuConversions ??= {})[carrierId] = {
          ownerId: playerId, color: colors.length === 1 ? colors[0]! : null, asCardName,
        }
      },
    }
  },
  recoverAmountBonus(state, _ownerId, sourceId, sourceCardId) {
    const conversion = sourceCardId ? (state as Batch53State).b53MiaoyuConversions?.[sourceCardId] : undefined
    return conversion?.ownerId === sourceId && conversion.color === 'red' && conversion.asCardName === '桃' ? 1 : 0
  },
  outgoingDamage(state, ownerId, context) {
    const conversion = context.cardId ? (state as Batch53State).b53MiaoyuConversions?.[context.cardId] : undefined
    return conversion?.ownerId === ownerId && conversion.color === 'red' && conversion.asCardName === '杀' && context.nature === 'fire'
      ? { amount: context.amount + 1 } : null
  },
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (!cardId) return
    const conversion = (host.state as Batch53State).b53MiaoyuConversions?.[cardId]
    if (conversion?.ownerId !== ownerId) return
    if (conversion?.color === 'black') askMiaoyuBlackCost(host, conversion.ownerId, cardId)
    else if (conversion) delete (host.state as Batch53State).b53MiaoyuConversions?.[cardId]
  } }, { event: 'CardResponded', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    const cardId = payload.cardId
    if (!cardId) return
    const conversion = (host.state as Batch53State).b53MiaoyuConversions?.[cardId]
    if (conversion?.ownerId !== ownerId) return
    if (conversion?.color === 'black') askMiaoyuBlackCost(host, conversion.ownerId, cardId)
    else if (conversion && payload.cardName !== '桃') delete (host.state as Batch53State).b53MiaoyuConversions?.[cardId]
  } }, { event: 'Recover', handle(host, ownerId, context) {
    const cardIds = (context.event.payload as { cardIds?: CardId[] }).cardIds ?? context.event.cardIds ?? []
    for (const cardId of cardIds) {
      const conversion = (host.state as Batch53State).b53MiaoyuConversions?.[cardId]
      if (conversion?.ownerId === ownerId) delete (host.state as Batch53State).b53MiaoyuConversions?.[cardId]
    }
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'black-cost') return
    const data = resolution.data as { cardId: CardId; targetId: PlayerId }
    const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = picked ? resolvePickedCard(host.state, data.targetId, picked) : null
    if (cardId && movePickedCard(host as never, data.targetId, cardId, { kind: 'discardPile' })) {
      host.dispatch('LoseCard', { playerId: data.targetId, cardIds: [cardId], reason: SS_MIAOYU }, { sourceId: ownerId, targetId: data.targetId, cardIds: [cardId] })
    }
    delete (host.state as Batch53State).b53MiaoyuConversions?.[data.cardId]
  },
})

function askMiaoyuBlackCost(host: SkillHost, ownerId: PlayerId, cardId: CardId): void {
  const targetId = host.state.currentPlayerId
  if (!targetId) { delete (host.state as Batch53State).b53MiaoyuConversions?.[cardId]; return }
  const pickable = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
  if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) {
    delete (host.state as Batch53State).b53MiaoyuConversions?.[cardId]
    return
  }
  host.askSkill({ skillId: SS_MIAOYU, ownerId, step: 'black-cost', data: { cardId, targetId }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【妙语】：弃置当前回合角色区域里的一张牌',
    timeoutMs: 30_000, optional: false, purpose: 'skill', cardIds: pickable.cardIds,
    hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
  }) })
}

registerSkillRuntime({ id: SS_NIQU,
  activeActions(state, ownerId) {
    const owner = state.players.find((candidate) => candidate.id === ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, SS_NIQU) || !state.players.some((candidate) => candidate.alive)) return []
    return [{ id: `skill:${SS_NIQU}`, label: '逆取：对一名角色造成1点火焰伤害' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${SS_NIQU}` || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || usedThisPhase(host.state, ownerId, SS_NIQU)) return
    const candidates = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    askTargets(host, SS_NIQU, ownerId, 'target', '【逆取】：选择一名角色受到1点火焰伤害', candidates, {}, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target' || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || usedThisPhase(host.state, ownerId, SS_NIQU)) return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !host.state.players.some((candidate) => candidate.id === targetId && candidate.alive)) return
    markUsedThisPhase(host.state, ownerId, SS_NIQU)
    resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'fire', cardName: null })
  },
})

registerSkillRuntime({ id: SS_XIAO,
  activeActions(state, ownerId) {
    const owner = state.players.find((candidate) => candidate.id === ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, SS_XIAO)) return []
    return [{ id: `skill:${SS_XIAO}`, label: '宵赂：摸两张牌，然后弃置两张手牌或交给他人两张手牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${SS_XIAO}` || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || usedThisPhase(host.state, ownerId, SS_XIAO) || !player(host, ownerId)?.alive) return
    markUsedThisPhase(host.state, ownerId, SS_XIAO)
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
    const owner = player(host, ownerId)
    const options = [
      ...(owner && owner.zones.hand.length >= 2 ? [{ id: 'discard', label: '弃置两张手牌' }] : []),
      ...(owner && owner.zones.hand.length >= 2 && others(host, ownerId).length > 0
        ? [{ id: 'give', label: '交给一名其他角色两张手牌' }] : []),
    ]
    if (options.length === 0) return
    askOption(host, SS_XIAO, ownerId, 'choice', ownerId, '【宵赂】：选择弃置两张手牌，或交给一名其他角色两张手牌', [
      ...options,
    ], {}, false)
  },
  resume(host, ownerId, resolution, response) {
    const owner = player(host, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'choice') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'discard') {
        if (owner.zones.hand.length < 2) return
        askCards(host, SS_XIAO, ownerId, 'discard', ownerId, [...owner.zones.hand], 2, 2, '【宵赂】：选择弃置两张手牌', {}, false)
      } else if (optionId === 'give' && others(host, ownerId).length > 0 && owner.zones.hand.length >= 2) {
        askTargets(host, SS_XIAO, ownerId, 'recipient', '【宵赂】：选择获得两张手牌的其他角色', others(host, ownerId).map((target) => target.id), {}, false)
      }
      return
    }
    if (resolution.step === 'discard') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cardIds.length !== 2 || cardIds.some((id) => !owner.zones.hand.includes(id))) return
      discard(host, ownerId, cardIds, SS_XIAO)
      return
    }
    if (resolution.step === 'recipient') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || targetId === ownerId || !player(host, targetId)?.alive || owner.zones.hand.length < 2) return
      askCards(host, SS_XIAO, ownerId, 'give-cards', ownerId, [...owner.zones.hand], 2, 2, '【宵赂】：选择交给目标的两张手牌', { targetId }, false)
      return
    }
    if (resolution.step === 'give-cards') {
      const targetId = (resolution.data as { targetId?: PlayerId }).targetId
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!targetId || !player(host, targetId)?.alive || cardIds.length !== 2 || cardIds.some((id) => !owner.zones.hand.includes(id))) return
      giveCards(host as never, ownerId, targetId, cardIds, SS_XIAO)
    }
  },
})

registerSkillRuntime({ id: SS_ZIMOU, triggers: [
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    if (phase.playerId === ownerId && phase.phase === 'play') ((host.state as Batch53State).b53ZimouCount ??= {})[ownerId] = 0
  } },
  { event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || !player(host, ownerId)?.alive) return
    const state = host.state as Batch53State
    const count = ((state.b53ZimouCount ??= {})[ownerId] ?? 0) + 1
    state.b53ZimouCount[ownerId] = count
    const reward = count === 2 ? '酒' : count === 4 ? '杀' : count === 6 ? '决斗' : null
    if (!reward) return
    const cardId = host.state.zones.drawPile.find((id) => host.state.cards[id]?.name === reward)
    if (!cardId) return
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: SS_ZIMOU }, { targetId: ownerId, cardIds: [cardId] })
  } },
] })

registerJudgmentContinuation(SS_PICAI_JUDGE, (host, _judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const owner = player(host, ownerId)
  if (!owner?.alive) {
    endJudgmentRetention(host.state, null)
    return
  }
  const suits = retainedJudgmentSuits(host.state)
  const latest = suits[suits.length - 1]
  if (suits.length > 1 && suits.slice(0, -1).includes(latest!)) {
    askTargets(host, SS_PICAI, ownerId, 'recipient', `【庀材】：将${retainedJudgmentCards(host.state).length}张生效的判定牌交给一名角色`,
      host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id), {}, false)
    return
  }
  askOption(host, SS_PICAI, ownerId, 'repeat', ownerId, '【庀材】：本次判定花色与此前均不同，是否继续判定？', [
    { id: 'continue', label: '继续判定' }, { id: 'finish', label: '结束判定并交出所有判定牌' },
  ], {}, false)
})

registerSkillRuntime({ id: SS_PICAI,
  activeActions(state, ownerId) {
    const owner = state.players.find((candidate) => candidate.id === ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, SS_PICAI)) return []
    return [{ id: `skill:${SS_PICAI}`, label: '庀材：判定并可重复，最后交出所有判定牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${SS_PICAI}` || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || usedThisPhase(host.state, ownerId, SS_PICAI) || !player(host, ownerId)?.alive) return
    markUsedThisPhase(host.state, ownerId, SS_PICAI)
    beginJudgmentRetention(host.state, ownerId, SS_PICAI_JUDGE)
    performJudgment(host as never, ownerId, '庀材', { tag: SS_PICAI_JUDGE, data: { ownerId } })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'repeat') {
      if ((response.payload as { optionId?: string }).optionId === 'continue') {
        performJudgment(host as never, ownerId, '庀材', { tag: SS_PICAI_JUDGE, data: { ownerId } })
        return
      }
      const cards = retainedJudgmentCards(host.state)
      if (cards.length === 0) { endJudgmentRetention(host.state, null); return }
      askTargets(host, SS_PICAI, ownerId, 'recipient', `【庀材】：将${cards.length}张生效的判定牌交给一名角色`,
        host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id), {}, false)
      return
    }
    if (resolution.step !== 'recipient') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !player(host, targetId)?.alive) return
    const cards = endJudgmentRetention(host.state, targetId)
    if (cards.length > 0) host.dispatch('GainCard', { playerId: targetId, cardIds: cards, reason: SS_PICAI }, { sourceId: ownerId, targetId, cardIds: cards })
  },
})

registerSkillRuntime({ id: SS_KUIJI,
  activeActions(state, ownerId) {
    const owner = state.players.find((candidate) => candidate.id === ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, SS_KUIJI)) return []
    return state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)
      ? [{ id: `skill:${SS_KUIJI}`, label: '窥机：观看一名其他角色手牌，并可弃置双方四张花色各异的手牌' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${SS_KUIJI}` || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || usedThisPhase(host.state, ownerId, SS_KUIJI)) return
    const candidates = others(host, ownerId).filter((candidate) => candidate.zones.hand.length > 0)
    if (candidates.length === 0) return
    markUsedThisPhase(host.state, ownerId, SS_KUIJI)
    askTargets(host, SS_KUIJI, ownerId, 'view-target', '【窥机】：选择一名有手牌的其他角色观看其手牌', candidates.map((candidate) => candidate.id), {}, true)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'view-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host, targetId) : undefined
      const owner = player(host, ownerId)
      if (!targetId || !target?.alive || target.id === ownerId || !owner?.alive) return
      const cards = kuijiDiscardableHands(host.state, ownerId, targetId)
      if (cards.length === 0) return
      host.askSkill({ skillId: SS_KUIJI, ownerId, step: 'discard-four', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId,
        prompt: `【窥机】：已观看${target.nickname}的手牌；可从双方手牌中弃置四张花色各不相同的牌`,
        timeoutMs: 30_000, optional: true, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 0, max: Math.min(4, cards.length),
      }) })
      return
    }
    if (resolution.step !== 'discard-four') return
    const targetId = (resolution.data as { targetId?: PlayerId }).targetId
    const target = targetId ? player(host, targetId) : undefined
    const owner = player(host, ownerId)
    if (!targetId || !target?.alive || !owner?.alive) return
    const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
    if (selected.length === 0) return
    const currentHands = new Set(kuijiDiscardableHands(host.state, ownerId, targetId))
    if (selected.length !== 4 || selected.some((id) => !currentHands.has(id))) {
      if (currentHands.size === 0) return
      host.askSkill({ skillId: SS_KUIJI, ownerId, step: 'discard-four', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【窥机】：必须恰好选择双方手牌中四张花色各不相同的牌；也可不弃置',
        timeoutMs: 30_000, optional: true, purpose: 'skill', cardIds: [...currentHands], hiddenCardSlots: [], min: 0, max: Math.min(4, currentHands.size),
      }) })
      return
    }
    const suits = selected.map((id) => effectiveCardSuit(host.state, owner.zones.hand.includes(id) ? ownerId : targetId, id))
    if (suits.some((suit) => !suit) || new Set(suits).size !== 4) {
      if (currentHands.size === 0) return
      host.askSkill({ skillId: SS_KUIJI, ownerId, step: 'discard-four', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【窥机】：所选四张牌须分别为四种花色；也可不弃置',
        timeoutMs: 30_000, optional: true, purpose: 'skill', cardIds: [...currentHands], hiddenCardSlots: [], min: 0, max: Math.min(4, currentHands.size),
      }) })
      return
    }
    const byOwner = new Map<PlayerId, CardId[]>()
    for (const cardId of selected) {
      const holderId = owner.zones.hand.includes(cardId) ? ownerId : targetId
      const cards = byOwner.get(holderId) ?? []
      cards.push(cardId)
      byOwner.set(holderId, cards)
      moveCard(host.state, cardId, { kind: 'hand', playerId: holderId }, { kind: 'discardPile' })
    }
    for (const [holderId, cardIds] of byOwner)
      host.dispatch('LoseCard', { playerId: holderId, cardIds, reason: SS_KUIJI }, { sourceId: ownerId, targetId: holderId, cardIds })
  },
})

function kuijiDiscardableHands(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): CardId[] {
  const owner = state.players.find((candidate) => candidate.id === ownerId)
  const target = state.players.find((candidate) => candidate.id === targetId)
  if (!owner?.alive || !target?.alive) return []
  return [...owner.zones.hand.filter((id) => !isCardProtectedFromDiscard(state, ownerId, id, ownerId)),
    ...target.zones.hand.filter((id) => !isCardProtectedFromDiscard(state, targetId, id, ownerId))]
}
