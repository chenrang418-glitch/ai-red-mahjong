import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, STANDARD_CHARACTERS, allCharacterIds, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { WIND_CHARACTERS } from '@/sanguosha/data/characters/wind'
import { FIRE_CHARACTERS } from '@/sanguosha/data/characters/fire'
import { FOREST_CHARACTERS } from '@/sanguosha/data/characters/forest'
import { MOUNTAIN_CHARACTERS } from '@/sanguosha/data/characters/mountain'
import { GOD_CHARACTERS } from '@/sanguosha/data/characters/god'
import { YJCM2011_CHARACTERS } from '@/sanguosha/data/characters/yjcm2011'
import { YJCM2012_CHARACTERS } from '@/sanguosha/data/characters/yjcm2012'
import { YJCM2013_CHARACTERS } from '@/sanguosha/data/characters/yjcm2013'
import { YJCM2014_CHARACTERS } from '@/sanguosha/data/characters/yjcm2014'
import { YJCM2015_CHARACTERS } from '@/sanguosha/data/characters/yjcm2015'
import { SP_CHARACTERS } from '@/sanguosha/data/characters/sp'
import { JIN_CHARACTERS } from '@/sanguosha/data/characters/jin'
import { JIN2_CHARACTERS } from '@/sanguosha/data/characters/jin2'
import { WEI_JIN_HISTORICAL_CHARACTERS } from '@/sanguosha/data/characters/wei-jin-historical'
import { HISTORICAL_BATCH19_CHARACTERS } from '@/sanguosha/data/characters/historical-batch19'
import { HISTORICAL_BATCH20_CHARACTERS } from '@/sanguosha/data/characters/historical-batch20'
import { HISTORICAL_BATCH21_CHARACTERS } from '@/sanguosha/data/characters/historical-batch21'
import { HISTORICAL_BATCH22_CHARACTERS } from '@/sanguosha/data/characters/historical-batch22'
import { HISTORICAL_BATCH23_CHARACTERS } from '@/sanguosha/data/characters/historical-batch23'
import { HISTORICAL_BATCH24_CHARACTERS } from '@/sanguosha/data/characters/historical-batch24'
import { HISTORICAL_BATCH25_CHARACTERS } from '@/sanguosha/data/characters/historical-batch25'
import { HISTORICAL_BATCH26_CHARACTERS } from '@/sanguosha/data/characters/historical-batch26'
import { HISTORICAL_BATCH27_CHARACTERS } from '@/sanguosha/data/characters/historical-batch27'
import { HISTORICAL_BATCH28_CHARACTERS } from '@/sanguosha/data/characters/historical-batch28'
import { HISTORICAL_BATCH29_CHARACTERS } from '@/sanguosha/data/characters/historical-batch29'
import { HISTORICAL_BATCH30_CHARACTERS } from '@/sanguosha/data/characters/historical-batch30'
import { HISTORICAL_BATCH31_CHARACTERS } from '@/sanguosha/data/characters/historical-batch31'
import { WUKE_B34, LIUZHANG_B34, MOU_LIUCHENG_B34, MOUYUANSHAO_B34, PANGXI_B34, SHI_HUANGZU_B34, SHI_SUNCHEN_B34, SHI_TAISHICI_B34, SIMAZHAO_SP_B34, MOU_GONGSUNZAN_B34 } from '@/sanguosha/data/characters/historical-batch32'
import { LAIMIN_B35, LIFENG_B35, LIRU_JIE_B35, MAJUN_B35, MALIANG_B35, MIFUREN_B35, PANGDEGONG_B35, PANZHANG_MAZHONG_JIE_B35, YANBAIHU_B35, ZERONG_B35 } from '@/sanguosha/data/characters/historical-batch33'
import { HISTORICAL_BATCH34_CHARACTERS } from '@/sanguosha/data/characters/historical-batch34'
import { HISTORICAL_BATCH35_CHARACTERS } from '@/sanguosha/data/characters/historical-batch35'
import { HISTORICAL_BATCH36_CHARACTERS } from '@/sanguosha/data/characters/historical-batch36'
import { HISTORICAL_BATCH37_CHARACTERS } from '@/sanguosha/data/characters/historical-batch37'
import { HISTORICAL_BATCH38_CHARACTERS } from '@/sanguosha/data/characters/historical-batch38'
import { HISTORICAL_BATCH39_CHARACTERS } from '@/sanguosha/data/characters/historical-batch39'
import { HISTORICAL_BATCH40_CHARACTERS } from '@/sanguosha/data/characters/historical-batch40'
import { HISTORICAL_BATCH41_CHARACTERS } from '@/sanguosha/data/characters/historical-batch41'
import { HISTORICAL_BATCH42_CHARACTERS } from '@/sanguosha/data/characters/historical-batch42'
import { HISTORICAL_BATCH43_CHARACTERS } from '@/sanguosha/data/characters/historical-batch43'
import { HISTORICAL_BATCH45_PART1, HISTORICAL_BATCH45_PART2 } from '@/sanguosha/data/characters/historical-batch45'
import { HISTORICAL_BATCH46_PART1, HISTORICAL_BATCH46_PART2 } from '@/sanguosha/data/characters/historical-batch46'
import { HISTORICAL_BATCH47_CHARACTERS } from '@/sanguosha/data/characters/historical-batch47'
import { HISTORICAL_BATCH48_CHARACTERS } from '@/sanguosha/data/characters/historical-batch48'
import { HISTORICAL_BATCH49_CHARACTERS } from '@/sanguosha/data/characters/historical-batch49'
import { HISTORICAL_BATCH50_CHARACTERS } from '@/sanguosha/data/characters/historical-batch50'
import { HISTORICAL_BATCH51_CHARACTERS } from '@/sanguosha/data/characters/historical-batch51'
import { HISTORICAL_BATCH52_CHARACTERS } from '@/sanguosha/data/characters/historical-batch52'
import { HISTORICAL_BATCH53_CHARACTERS } from '@/sanguosha/data/characters/historical-batch53'
import { HISTORICAL_BATCH54_CHARACTERS } from '@/sanguosha/data/characters/historical-batch54'
import { HISTORICAL_BATCH55_CHARACTERS } from '@/sanguosha/data/characters/historical-batch55'
import { HISTORICAL_BATCH56_CHARACTERS } from '@/sanguosha/data/characters/historical-batch56'
import { HISTORICAL_BATCH57_CHARACTERS } from '@/sanguosha/data/characters/historical-batch57'
import { HISTORICAL_BATCH58_CHARACTERS } from '@/sanguosha/data/characters/historical-batch58'
import { HISTORICAL_BATCH59_CHARACTERS } from '@/sanguosha/data/characters/historical-batch59'
import { HISTORICAL_BATCH60_CHARACTERS } from '@/sanguosha/data/characters/historical-batch60'
import { HISTORICAL_BATCH61_CHARACTERS } from '@/sanguosha/data/characters/historical-batch61'
import { HISTORICAL_BATCH62_CHARACTERS } from '@/sanguosha/data/characters/historical-batch62'
import { HISTORICAL_BATCH63_CHARACTERS } from '@/sanguosha/data/characters/historical-batch63'
import { HISTORICAL_BATCH64_CHARACTERS } from '@/sanguosha/data/characters/historical-batch64'
import { HISTORICAL_BATCH65_CHARACTERS } from '@/sanguosha/data/characters/historical-batch65'
import { HISTORICAL_BATCH66_CHARACTERS } from '@/sanguosha/data/characters/historical-batch66'
import { HISTORICAL_BATCH67_CHARACTERS } from '@/sanguosha/data/characters/historical-batch67'
import { HISTORICAL_BATCH68_CHARACTERS } from '@/sanguosha/data/characters/historical-batch68'
import { HISTORICAL_BATCH69_CHARACTERS } from '@/sanguosha/data/characters/historical-batch69'
import { HISTORICAL_BATCH70_CHARACTERS } from '@/sanguosha/data/characters/historical-batch70'
import { HISTORICAL_BATCH71_CHARACTERS } from '@/sanguosha/data/characters/historical-batch71'
import { HISTORICAL_BATCH72_CHARACTERS } from '@/sanguosha/data/characters/historical-batch72'
import { HISTORICAL_BATCH73_CHARACTERS } from '@/sanguosha/data/characters/historical-batch73'
import { HISTORICAL_BATCH74_CHARACTERS } from '@/sanguosha/data/characters/historical-batch74'
import { HISTORICAL_BATCH75_CHARACTERS } from '@/sanguosha/data/characters/historical-batch75'
import { HISTORICAL_BATCH76_CHARACTERS } from '@/sanguosha/data/characters/historical-batch76'
import { HISTORICAL_BATCH77_CHARACTERS } from '@/sanguosha/data/characters/historical-batch77'
import { HISTORICAL_BATCH78_CHARACTERS } from '@/sanguosha/data/characters/historical-batch78'
import { HISTORICAL_BATCH79_CHARACTERS } from '@/sanguosha/data/characters/historical-batch79'
import { HISTORICAL_BATCH80_CHARACTERS } from '@/sanguosha/data/characters/historical-batch80'
import { HISTORICAL_BATCH81_CHARACTERS } from '@/sanguosha/data/characters/historical-batch81'
import { HISTORICAL_BATCH82_CHARACTERS } from '@/sanguosha/data/characters/historical-batch82'
import { HISTORICAL_BATCH83_CHARACTERS } from '@/sanguosha/data/characters/historical-batch83'
import { HISTORICAL_BATCH84_CHARACTERS } from '@/sanguosha/data/characters/historical-batch84'
import { HISTORICAL_BATCH85_CHARACTERS } from '@/sanguosha/data/characters/historical-batch85'
import { HISTORICAL_BATCH86_CHARACTERS } from '@/sanguosha/data/characters/historical-batch86'
import { HISTORICAL_BATCH87_CHARACTERS } from '@/sanguosha/data/characters/historical-batch87'
import { HISTORICAL_BATCH88_CHARACTERS } from '@/sanguosha/data/characters/historical-batch88'
import { HISTORICAL_BATCH89_CHARACTERS } from '@/sanguosha/data/characters/historical-batch89'
import { HISTORICAL_BATCH90_CHARACTERS } from '@/sanguosha/data/characters/historical-batch90'
import { FLASH_BATCH91_CHARACTERS } from '@/sanguosha/data/characters/flash-batch91'
import { FENGJI_2026 } from '@/sanguosha/data/characters/fengji-2026'
import { ENTERTAINMENT_CHARACTERS } from '@/sanguosha/data/characters/entertainment'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
// 技能运行时靠 import 副作用注册，而装备类技能（含铁骑、流离）注册在引擎侧。
// 不把引擎拉进来，这里会把已实现的技能误判成空壳。
import '@/sanguosha/engine/game'

/**
 * 武将包的边界。
 *
 * 最容易犯的错是让 `STANDARD_CHARACTERS` 实际装上扩展包武将——
 * 名字和内容对不上，之后所有「池子多大」的判断都会跟着错。
 * 这里把「谁属于哪个包」和「可用池子 = 全部已登记包之和」都钉死。
 */

const INDEPENDENT_REGISTRATION_SET = [
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

describe('包的归属不能串', () => {
  it('STANDARD_CHARACTERS 只装标准包', () => {
    for (const character of STANDARD_CHARACTERS) {
      expect(character.pack, `${character.name} 不该在标准包数组里`).toBe('standard')
    }
  })

  it('风包、火包、林包和娱乐包各自的 pack 字段也要对', () => {
    for (const character of WIND_CHARACTERS) expect(character.pack, `${character.name}`).toBe('wind')
    for (const character of FIRE_CHARACTERS) expect(character.pack, `${character.name}`).toBe('fire')
    for (const character of FOREST_CHARACTERS) expect(character.pack, `${character.name}`).toBe('forest')
    for (const character of MOUNTAIN_CHARACTERS) expect(character.pack, `${character.name}`).toBe('mountain')
    for (const character of GOD_CHARACTERS) expect(character.pack, `${character.name}`).toBe('god')
    for (const character of YJCM2011_CHARACTERS) expect(character.pack, `${character.name}`).toBe('yjcm2011')
    for (const character of YJCM2012_CHARACTERS) expect(character.pack, `${character.name}`).toBe('yjcm2012')
    for (const character of YJCM2013_CHARACTERS) expect(character.pack, `${character.name}`).toBe('yjcm2013')
    for (const character of YJCM2014_CHARACTERS) expect(character.pack, `${character.name}`).toBe('yjcm2014')
    for (const character of ENTERTAINMENT_CHARACTERS) expect(character.pack, `${character.name}`).toBe('entertainment')
  })

  it('可用池子正好是全部包之和，没有重复 id', () => {
    const independentIds = INDEPENDENT_REGISTRATION_SET.map((character) => character.id)
    const registeredIds = ALL_CHARACTERS.map((character) => character.id)
    expect(new Set(independentIds).size, '独立包集合自身不能有重复 id').toBe(independentIds.length)
    expect(new Set(registeredIds).size, '武将 id 不能重复').toBe(registeredIds.length)
    expect(registeredIds.slice().sort()).toEqual(independentIds.slice().sort())
  })

  it('allCharacterIds 给的是整个可用池，不只是标准包', () => {
    expect(allCharacterIds().length).toBe(ALL_CHARACTERS.length)
  })
})

describe('登记的武将必须真的能玩', () => {
  it('每个技能都有对应的运行时或被引擎直接消费', () => {
    // 引擎直接读技能 id 的锁定技（不走 registerSkillRuntime）
    const ENGINE_CONSUMED = new Set(['qicai'])
    const missing: string[] = []
    for (const character of ALL_CHARACTERS) {
      for (const skill of character.skills) {
        if (ENGINE_CONSUMED.has(skill.id)) continue
        if (!getSkillRuntime(skill.id)) missing.push(`${character.name}【${skill.name}】(${skill.id})`)
      }
    }
    expect(missing, '这些技能只有描述没有实现，属于空壳').toEqual([])
  })

  it('getCharacter 和 skillIdsOf 覆盖所有包', () => {
    for (const character of ALL_CHARACTERS) {
      expect(getCharacter(character.id), `${character.name} 查不到`).toBeTruthy()
      expect(skillIdsOf(character.id).length, `${character.name} 技能列表为空`).toBeGreaterThan(0)
    }
  })
})
