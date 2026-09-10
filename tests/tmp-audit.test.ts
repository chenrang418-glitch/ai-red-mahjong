import { describe, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter } from '@/sanguosha/data/characters/standard'
import { YJCM2012_CHARACTERS } from '@/sanguosha/data/characters/yjcm2012'
import { YJCM2011_CHARACTERS } from '@/sanguosha/data/characters/yjcm2011'
describe('audit', () => { it('audit', () => {
  const byPack: Record<string, string[]> = {}
  for (const c of ALL_CHARACTERS) (byPack[c.pack] ??= []).push(c.id)
  console.log('TOTAL=' + ALL_CHARACTERS.length)
  for (const p of ['standard','wind','fire','forest','mountain','god','yjcm2011','yjcm2012','entertainment']) {
    console.log('PACK ' + p + '=' + (byPack[p]?.length ?? 0))
  }
  console.log('YJCM2011_IDS=' + YJCM2011_CHARACTERS.map((c) => c.id).join(','))
  console.log('YJCM2012_IDS=' + YJCM2012_CHARACTERS.map((c) => c.id).join(','))
  for (const id of ['handang','bulianshi','liubiao','huaxiong']) {
    console.log('REG ' + id + '=' + (getCharacter(id) ? 'YES' : 'NO'))
  }
}) })
