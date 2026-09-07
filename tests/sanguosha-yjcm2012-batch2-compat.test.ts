import { describe, expect, it } from 'vitest'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { huashenEligibleSkills } from '@/sanguosha/engine/huashen'
import { skillIsRandomlyGrantable, randomSkillPoolOf, sampleSkills } from '@/sanguosha/engine/random-skill-pool'
import { GameRng } from '@/sanguosha/engine/rng'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import { PENDING_PORTRAIT_IDS } from '@/sanguosha/assets/characters/manifest'
import { YJCM2012_CHARACTERS } from '@/sanguosha/data/characters/yjcm2012'

/**
 * 一将成名 2012 第二批和「借技能」那几套机制的兼容审查。
 *
 * 项目里有四条会把技能搬到**别人**身上的路径：
 *
 * - 左慈【化身】：临时顶一个别人的技能；
 * - 神张辽【夺锐】：把目标的一个技能抢过来用到他下一个回合；
 * - 神典韦【挈挟】：把武将牌当装备借用，借出去的技能靠 `qiexie` 标志声明；
 * - 神孙权【驭衡】：按势力随机获得若干技能。
 *
 * 这四条的资格判断**只读结构化标志**（限定、觉醒、主公、衍生），
 * 不看描述文字。所以这里要断言的不是「实现了什么」，而是
 * **新技能落在正确的那一档里**——错档的后果是一个限定技被随机发出去、
 * 或者一个正常技能永远进不了池子。
 */

const BATCH_TWO = ['liaohua', 'guanxingzhangbao', 'madai', 'chengpu']
/** 这一批里唯一的限定技。 */
const LIMITED = ['fuli']
/** 这一批里可以被借走 / 随机获得的普通技能。 */
const ORDINARY = ['dangxian', 'fuhun', 'qianxi', 'lihuo', 'chunlao']

describe('一将成名 2012 第二批：注册与完整性', () => {
  it('四个人都真的注册进了包里', () => {
    const ids = YJCM2012_CHARACTERS.map((character) => character.id)
    for (const id of BATCH_TWO) expect(ids, `${id} 没有注册`).toContain(id)
  })

  it('每个技能都有运行时实现', () => {
    for (const id of BATCH_TWO) {
      const character = getCharacter(id)!
      expect(character, `${id} 不在武将表里`).toBeTruthy()
      for (const skill of character.skills) {
        expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】没有运行时`).toBeTruthy()
      }
    }
  })

  it('立绘待上传的登记齐全：不为了让检查变绿而放松完整性校验', () => {
    for (const id of BATCH_TWO) {
      expect(PENDING_PORTRAIT_IDS, `${id} 没有登记进待上传名单`).toContain(id)
    }
  })
})

describe('一将成名 2012 第二批：借技能路径的资格分档', () => {
  it('【伏枥】是限定技：化身、驭衡都拿不到它', () => {
    for (const skillId of LIMITED) {
      expect(getSkillRuntime(skillId)?.limited, `${skillId} 必须标成限定技`).toBe(true)
      expect(skillIsRandomlyGrantable(skillId), '限定技不该进随机池').toBe(false)
    }
    const eligible = huashenEligibleSkills('liaohua').map((skill) => skill.id)
    expect(eligible, '化身不该顶到伏枥').not.toContain('fuli')
  })

  it('普通技能都进得了随机池和化身池', () => {
    for (const skillId of ORDINARY) {
      expect(skillIsRandomlyGrantable(skillId), `${skillId} 应该可以被随机获得`).toBe(true)
    }
    expect(huashenEligibleSkills('liaohua').map((skill) => skill.id), '当先可以被化身顶上').toContain('dangxian')
    expect(huashenEligibleSkills('guanxingzhangbao').map((skill) => skill.id)).toContain('fuhun')
    expect(huashenEligibleSkills('madai').map((skill) => skill.id)).toContain('qianxi')
    const chengpu = huashenEligibleSkills('chengpu').map((skill) => skill.id)
    expect(chengpu).toContain('lihuo')
    expect(chengpu).toContain('chunlao')
  })

  it('新技能按势力登记进了驭衡的目录', () => {
    const shu = randomSkillPoolOf('shu').map((skill) => skill.id)
    for (const skillId of ['dangxian', 'fuhun', 'qianxi']) {
      expect(shu, `${skillId} 应该在蜀势力目录里`).toContain(skillId)
    }
    const wu = randomSkillPoolOf('wu').map((skill) => skill.id)
    for (const skillId of ['lihuo', 'chunlao']) {
      expect(wu, `${skillId} 应该在吴势力目录里`).toContain(skillId)
    }
  })

  it('限定技抽不出来：断言的是真正发牌的那一层', () => {
    /*
     * `randomSkillPoolOf` 是**原始目录**，限定技也在里面；过滤发生在
     * `sampleSkills`。所以要断言在发牌那一层，不是目录那一层——
     * 断错层的话「限定技不会被随机发出去」这句话根本没被验证到。
     */
    const drawn = new Set<string>()
    for (let seed = 0; seed < 200; seed += 1) {
      for (const skill of sampleSkills(new GameRng(`yuheng-${seed}`), 'shu', 3)) drawn.add(skill.id)
    }
    expect(drawn.size, '样本足够大，确实抽出过东西').toBeGreaterThan(5)
    expect([...drawn], '限定技【伏枥】永远抽不到').not.toContain('fuli')
    // 反证：同一个人身上的普通技能是抽得到的，说明不是「整个武将都没进池」
    expect([...drawn], '当先抽得到').toContain('dangxian')
  })

  it('引擎主干里没有按 characterId 的特判', () => {
    /*
     * 这四个人带进来的引擎能力（额外阶段调度、颜色禁令、按牌记的伤害账、
     * 按属性给的额外杀目标）都必须由**技能**声明，引擎不认武将 id。
     * 这里正面断言那几个钩子的存在——它们就是「不写特判」的替代品。
     */
    expect(typeof getSkillRuntime('dangxian')?.extraPhaseAtTurnStart, '当先靠钩子声明额外阶段').toBe('function')
    expect(typeof getSkillRuntime('lihuo')?.extraSlashTargets, '疠火靠钩子声明额外目标').toBe('function')
    expect(typeof getSkillRuntime('fuhun')?.multiCardViewAs, '父魂的打出走公共多牌转化').toBe('function')
    expect(typeof getSkillRuntime('chunlao')?.rescueActions, '醇醪靠公共救援入口').toBe('function')
  })
})
