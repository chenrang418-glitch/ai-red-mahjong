import { occupiedCharacterIds } from './character-equipment'
import type { GameRng } from './rng'
import type { CharacterId, SanguoshaState } from './types'

/**
 * 「从武将池里随机抽几张武将牌」的公共入口（神典韦【挈挟】）。
 *
 * 为什么不直接 `random(ALL_CHARACTERS)`：
 *
 * - 池子要按**当前模式**算，不是「代码里定义过的全部武将」；
 * - **已经上场的角色**不能再被抽出来当牌用，否则同一名武将同时在两处存在；
 * - **已经被别人拿在装备区**的武将同理；
 * - 随机必须用牌局自己的种子，重连之后候选一模一样。
 */

export interface PoolCharacter {
  id: CharacterId
  name: string
  pack: string
  maxHp: number
}

let catalog: readonly PoolCharacter[] = []

export function provideCharacterPool(characters: readonly PoolCharacter[]): void {
  catalog = characters
}

export function poolCharacter(characterId: CharacterId): PoolCharacter | undefined {
  return catalog.find((character) => character.id === characterId)
}

export interface SampleOptions {
  /** 排除这些包（默认排掉娱乐包：它不属于常规模式的武将池）。 */
  excludePacks?: readonly string[]
  /** 额外排除的武将。 */
  exclude?: readonly CharacterId[]
}

/**
 * 从武将池里随机抽 `count` 名。
 *
 * 池子不够就有多少抽多少——**不补、不重复**。抽出来的顺序本身就是随机的，
 * 调用方不要再排序，那会把随机性抹掉一半。
 */
export function sampleCharacters(
  state: SanguoshaState,
  rng: GameRng,
  count: number,
  options: SampleOptions = {},
): PoolCharacter[] {
  const excludePacks = new Set(options.excludePacks ?? ['entertainment'])
  const excluded = new Set<CharacterId>([
    // 已经上场的：同一名武将不能既在座位上又在装备区里
    ...state.players.map((player) => player.characterId).filter((id): id is CharacterId => !!id),
    // 已经被拿去当装备的
    ...occupiedCharacterIds(state),
    ...(options.exclude ?? []),
  ])
  const pool = catalog.filter((character) => !excludePacks.has(character.pack) && !excluded.has(character.id))
  const picked: PoolCharacter[] = []
  const remaining = [...pool]
  for (let index = 0; index < count && remaining.length > 0; index += 1) {
    picked.push(...remaining.splice(rng.nextInt(remaining.length), 1))
  }
  return picked
}
