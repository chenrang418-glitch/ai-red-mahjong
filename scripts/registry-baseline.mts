import { ALL_CHARACTERS } from '../src/sanguosha/data/characters/standard'
const byPack = new Map<string, string[]>()
for (const c of ALL_CHARACTERS) byPack.set(c.pack, [...(byPack.get(c.pack) ?? []), c.id])
console.log('TOTAL', ALL_CHARACTERS.length)
for (const pack of ['standard', 'wind', 'fire', 'forest', 'mountain', 'god', 'yjcm2011', 'entertainment']) {
  console.log(pack, byPack.get(pack)?.length ?? 0)
}
for (const id of ['caozhi', 'yujin', 'zhangchunhua', 'fazheng']) {
  console.log(id, ALL_CHARACTERS.some((c) => c.id === id) ? 'REGISTERED' : 'not registered')
}
console.log('GOD', (byPack.get('god') ?? []).length)
