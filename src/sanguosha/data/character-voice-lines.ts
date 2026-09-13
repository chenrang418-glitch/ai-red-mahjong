/**
 * 已录制技能台词的武将，以及台词地址的生成规则。
 *
 * 目录名**就是武将 id**，运行时按「人物 id + 技能 id」两个键定位。
 * 同一技能的两条成品都登记在数组里，由播放层在每次发动时随机选择。
 * 文件放在 public 独立目录，这里只生成地址，不会在进牌桌时一次性导入或解码全部音频。
 * 台词文案均为本项目原创生成稿。
 *
 * **目录名不带顺序前缀**，这是刻意的。原来是 `001-zhangfei` 这种，
 * 序号由武将表的列表顺序算出来——只要有人在表中间插一个新武将，
 * 后面所有人的序号全部错位，语音会整片 404。武将表还在持续增加，
 * 把地址和列表顺序绑在一起迟早会踩。现在地址只依赖 id。
 *
 * **名单也必须是显式的**，不能写成「所有非娱乐武将」。
 * 那样每加一名新武将就等于凭空声明「他有台词」，实际拿到的是一串 404，
 * 而且没有任何地方会提醒你漏录了。现在新武将默认不在名单里：
 * 没有台词，但不报错、不让测试红。补齐音频之后把 id 加进来即可——
 * 这一步是有意保留的手动动作，它就是「台词已录制」这件事的唯一事实来源。
 */
import { ALL_CHARACTERS } from './characters/standard'

/** 已经录好两条台词的武将 id。补录之后在这里登记。 */
export const VOICED_CHARACTER_IDS: ReadonlySet<string> = new Set([
])

const baseUrl = import.meta.env.BASE_URL.replace(/\/?$/, '/')
const voicedCharacters = ALL_CHARACTERS.filter((character) => VOICED_CHARACTER_IDS.has(character.id))
const voiceSkillIds = new Map(voicedCharacters.map((character) => [
  character.id,
  new Set(character.skills.map((skill) => skill.id)),
]))

export function characterSkillVoiceUrls(characterId: string | undefined, skillId: string | undefined): readonly string[] {
  if (!characterId || !skillId) return []
  // 两个键都要对上：马超和庞德都有【马术】，只按技能 id 找会串音
  if (!voiceSkillIds.get(characterId)?.has(skillId)) return []
  const prefix = `${baseUrl}sanguosha/voice/characters/${characterId}/${skillId}`
  return [`${prefix}-01.mp3`, `${prefix}-02.mp3`]
}

/** 已登记台词的武将。测试按它比对磁盘上的目录。 */
export const VOICED_CHARACTERS = voicedCharacters

export const CHARACTER_SKILL_VOICE_SKILL_COUNT = voicedCharacters.reduce((total, character) => total + character.skills.length, 0)
export const CHARACTER_SKILL_VOICE_ASSET_COUNT = CHARACTER_SKILL_VOICE_SKILL_COUNT * 2
