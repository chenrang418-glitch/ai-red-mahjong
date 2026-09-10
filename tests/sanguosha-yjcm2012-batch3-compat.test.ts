import { describe, expect, it } from 'vitest'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { huashenEligibleSkills } from '@/sanguosha/engine/huashen'
import { randomSkillPoolOf, sampleSkills, skillIsRandomlyGrantable } from '@/sanguosha/engine/random-skill-pool'
import { GameRng } from '@/sanguosha/engine/rng'
import { ALL_CHARACTERS, getCharacter } from '@/sanguosha/data/characters/standard'
import { PENDING_PORTRAIT_IDS } from '@/sanguosha/assets/characters/manifest'
import { YJCM2012_CHARACTERS } from '@/sanguosha/data/characters/yjcm2012'

/**
 * 一将成名 2012 第三批 / FINAL 的注册完整性与「借技能」兼容审查。
 *
 * 四条会把技能搬到**别人**身上的路径：左慈【化身】、神张辽【夺锐】、
 * 神典韦【挈挟】、神孙权【驭衡】。它们的资格判断**只读结构化标志**
 * （限定、觉醒、主公、衍生），不看描述文字——所以这里断言的不是
 * 「实现了什么」，而是**新技能落在正确的那一档里**。
 */

const BATCH_THREE = ['handang', 'bulianshi', 'liubiao', 'huaxiong']
const ALL_TWELVE = [
  'caozhang', 'zhonghui', 'xunyou', 'wangyi',
  'liaohua', 'guanxingzhangbao', 'madai', 'chengpu',
  'handang', 'bulianshi', 'liubiao', 'huaxiong',
]
/** 这一批里唯一的限定技。 */
const LIMITED = ['jiefan']
/** 这一批里可以被借走 / 随机获得的普通技能。 */
const ORDINARY = ['gongqi', 'anxu', 'zhuiyi', 'zishou', 'zongshi', 'yaowu']

describe('一将成名 2012：收官时的注册完整性', () => {
  it('12 个人全部真实注册进了包里', () => {
    const ids = YJCM2012_CHARACTERS.map((character) => character.id)
    for (const id of ALL_TWELVE) expect(ids, `${id} 没有注册`).toContain(id)
    expect(ids.length, 'yjcm2012 恰好 12 人，没有多也没有少').toBe(12)
  })

  it('每个技能都有运行时实现，没有空壳', () => {
    for (const id of ALL_TWELVE) {
      const character = getCharacter(id)!
      expect(character, `${id} 不在武将表里`).toBeTruthy()
      expect(character.skills.length, `${id} 一个技能都没有`).toBeGreaterThan(0)
      for (const skill of character.skills) {
        expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】没有运行时`).toBeTruthy()
        expect(skill.description.length, `${character.name}【${skill.name}】没有说明文字`).toBeGreaterThan(0)
      }
    }
  })

  it('立绘待上传的登记齐全：不为了让检查变绿而放松完整性校验', () => {
    for (const id of BATCH_THREE) {
      expect(PENDING_PORTRAIT_IDS, `${id} 没有登记进待上传名单`).toContain(id)
    }
  })

  it('武将 id 全局唯一', () => {
    const ids = ALL_CHARACTERS.map((character) => character.id)
    expect(new Set(ids).size, '有重复的武将 id').toBe(ids.length)
  })
})

describe('一将成名 2012 第三批：借技能路径的资格分档', () => {
  it('【解烦】是限定技：化身、驭衡都拿不到它', () => {
    for (const skillId of LIMITED) {
      expect(getSkillRuntime(skillId)?.limited, `${skillId} 必须标成限定技`).toBe(true)
      expect(skillIsRandomlyGrantable(skillId), '限定技不该进随机池').toBe(false)
    }
    expect(huashenEligibleSkills('handang').map((skill) => skill.id), '化身不该顶到解烦').not.toContain('jiefan')
  })

  it('普通技能都进得了随机池和化身池', () => {
    for (const skillId of ORDINARY) {
      expect(skillIsRandomlyGrantable(skillId), `${skillId} 应该可以被随机获得`).toBe(true)
    }
    expect(huashenEligibleSkills('handang').map((skill) => skill.id)).toContain('gongqi')
    const bu = huashenEligibleSkills('bulianshi').map((skill) => skill.id)
    expect(bu).toContain('anxu')
    expect(bu).toContain('zhuiyi')
    const liu = huashenEligibleSkills('liubiao').map((skill) => skill.id)
    expect(liu).toContain('zishou')
    expect(liu).toContain('zongshi')
    expect(huashenEligibleSkills('huaxiong').map((skill) => skill.id)).toContain('yaowu')
  })

  it('限定技抽不出来：断言的是真正发牌的那一层', () => {
    /*
     * `randomSkillPoolOf` 是**原始目录**，限定技也在里面；过滤发生在
     * `sampleSkills`。断错层的话「限定技不会被随机发出去」这句话
     * 根本没被验证到。
     */
    const drawn = new Set<string>()
    for (let seed = 0; seed < 240; seed += 1) {
      for (const skill of sampleSkills(new GameRng(`yuheng-b3-${seed}`), 'wu', 3)) drawn.add(skill.id)
    }
    expect(drawn.size, '样本足够大，确实抽出过东西').toBeGreaterThan(5)
    expect([...drawn], '限定技【解烦】永远抽不到').not.toContain('jiefan')
    expect([...drawn], '同一个人身上的弓骑抽得到').toContain('gongqi')
  })

  it('新技能按势力登记进了驭衡的目录', () => {
    const wu = randomSkillPoolOf('wu').map((skill) => skill.id)
    for (const skillId of ['gongqi', 'jiefan', 'anxu', 'zhuiyi']) {
      expect(wu, `${skillId} 应该在吴势力目录里`).toContain(skillId)
    }
    const qun = randomSkillPoolOf('qun').map((skill) => skill.id)
    for (const skillId of ['zishou', 'zongshi', 'yaowu']) {
      expect(qun, `${skillId} 应该在群势力目录里`).toContain(skillId)
    }
  })

  it('引擎主干靠钩子接入，不认武将 id', () => {
    /*
     * 这一批带进来的引擎能力都必须由**技能**声明。
     * 正面断言那几个钩子的存在——它们就是「不写特判」的替代品。
     */
    expect(typeof getSkillRuntime('zongshi')?.maxCardsBonus, '宗室靠公共的手牌上限加成钩子').toBe('function')
    expect(typeof getSkillRuntime('zhuiyi')?.startQueued, '追忆靠公共的技能队列').toBe('function')
    expect(getSkillRuntime('zhuiyi')?.allowsDeadResponder, '追忆显式声明「可以问死人」').toBe(true)
    expect(typeof getSkillRuntime('yaowu')?.startQueued, '耀武同样走技能队列').toBe('function')
    expect(typeof getSkillRuntime('anxu')?.activeActions, '安恤是主动技').toBe('function')
  })

  it('会「使用一张牌」的主动技都声明了 activeActionUsesCard', () => {
    /*
     * 不声明的话，被【离迹】这类封牌效果压住时按钮照出、点下去静默失败，
     * 场面一点没变——压测里跑成无限循环（seed=banner-18）。
     * 这条把三个已知会用牌的主动技钉住，以后新增同类技能漏声明会当场红。
     */
    for (const skillId of ['qice', 'fuhun', 'lihuo']) {
      expect(getSkillRuntime(skillId)?.activeActionUsesCard, `${skillId} 必须声明它会使用一张牌`).toBe(true)
    }
    // 反面：弓骑只弃牌、安恤只转移牌，都不「使用」牌，所以不该声明
    for (const skillId of ['gongqi', 'anxu']) {
      expect(getSkillRuntime(skillId)?.activeActionUsesCard, `${skillId} 不使用牌，不该声明`).toBeFalsy()
    }
  })
})
