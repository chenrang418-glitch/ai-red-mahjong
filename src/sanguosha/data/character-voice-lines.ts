/**
 * 非自定义武将的原创技能台词音频。
 *
 * 文件夹名带人物顺序，运行时只取人物 id 与技能 id；同一技能的两条成品都
 * 登记在数组中，由播放层在每次发动时随机选择。文件放在 public 独立目录，
 * 这里只按当前人物表生成地址，不会在进牌桌时一次性导入或解码 294 条音频。
 * 台词文案均为本项目原创生成稿，不使用其他游戏的官方台词。
 */
import { ALL_CHARACTERS } from './characters/standard'

const baseUrl = import.meta.env.BASE_URL.replace(/\/?$/, '/')
const officialCharacters = ALL_CHARACTERS.filter((character) => character.pack !== 'entertainment')
const voiceCharacters = new Map(officialCharacters.map((character, index) => [
  character.id,
  {
    directory: `${String(index + 1).padStart(3, '0')}-${character.id}`,
    skillIds: new Set(character.skills.map((skill) => skill.id)),
  },
]))

export function characterSkillVoiceUrls(characterId: string | undefined, skillId: string | undefined): readonly string[] {
  if (!characterId || !skillId) return []
  const character = voiceCharacters.get(characterId)
  if (!character?.skillIds.has(skillId)) return []
  const prefix = `${baseUrl}sanguosha/voice/characters/${character.directory}/${skillId}`
  return [`${prefix}-01.mp3`, `${prefix}-02.mp3`]
}

export const CHARACTER_SKILL_VOICE_SKILL_COUNT = officialCharacters.reduce((total, character) => total + character.skills.length, 0)
export const CHARACTER_SKILL_VOICE_ASSET_COUNT = CHARACTER_SKILL_VOICE_SKILL_COUNT * 2
