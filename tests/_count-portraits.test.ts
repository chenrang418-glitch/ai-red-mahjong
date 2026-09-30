import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'

describe('portrait inventory probe', () => {
  it('prints registry and target comparison', () => {
    const files = readdirSync('D:/cr/sanguoshalihui').filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
    const normalized = (value: string) => value.replace(/[^a-z0-9]/gi, '').toLowerCase()
    const ids = new Set(ALL_CHARACTERS.map((character) => normalized(character.id)))
    const extras = files.filter((file) => !ids.has(normalized(file.replace(/\.[^.]+$/, ''))))
    console.log(JSON.stringify({ count: ALL_CHARACTERS.length, imageCount: files.length, extras, entertainment: ALL_CHARACTERS.filter((character) => character.pack === 'entertainment').map((character) => ({ id: character.id, name: character.name })) }, null, 2))
    expect(ALL_CHARACTERS.length).toBe(364)
  })
})
