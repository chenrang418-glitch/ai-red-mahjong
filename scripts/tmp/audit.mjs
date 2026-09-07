import { ALL_CHARACTERS, getCharacter } from '../../src/sanguosha/data/characters/standard.ts'
const byPack = {}
for (const c of ALL_CHARACTERS) (byPack[c.pack] ??= []).push(c.id)
console.log('Total generals:', ALL_CHARACTERS.length)
for (const [pack, ids] of Object.entries(byPack)) console.log(`  ${pack}: ${ids.length}`)
console.log('YJCM2011:', (byPack.yjcm2011 ?? []).join(', '))
for (const id of ['caozhi','yujin','zhangchunhua','fazheng','masu','xushu','lingtong','wuguotai','xusheng','chengong','gaoshun']) {
  const c = getCharacter(id)
  console.log(`${id}: ${c ? 'REGISTERED [' + c.skills.map(s=>s.id).join(',') + ']' : 'NOT REGISTERED'}`)
}
