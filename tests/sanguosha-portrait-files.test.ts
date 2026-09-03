import { readFileSync, readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allCharacterIds } from '@/sanguosha/data/characters/standard'

const smallRoot = resolve('src/sanguosha/assets/characters/portraits')
const fullRoot = resolve('src/sanguosha/assets/characters/portraits-full')

function webpSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  const marker = bytes.indexOf(Buffer.from([0x9d, 0x01, 0x2a]))
  if (marker < 0 || marker + 7 > bytes.length) throw new Error(`无法读取 WebP 尺寸：${basename(path)}`)
  return {
    width: bytes.readUInt16LE(marker + 3) & 0x3fff,
    height: bytes.readUInt16LE(marker + 5) & 0x3fff,
  }
}

describe('立绘清晰度硬规格', () => {
  it('全部可玩武将都有 480×640 座位图和原始分辨率艺术集图', () => {
    const ids = [...allCharacterIds()].sort()
    const smallIds = readdirSync(smallRoot).filter((name) => name.endsWith('.webp')).map((name) => basename(name, '.webp')).sort()
    const fullIds = readdirSync(fullRoot).filter((name) => name.endsWith('.webp')).map((name) => basename(name, '.webp')).sort()
    expect(smallIds).toEqual(ids)
    expect(fullIds).toEqual(ids)

    for (const id of ids) {
      expect(webpSize(resolve(smallRoot, `${id}.webp`)), `${id} 座位图`).toEqual({ width: 480, height: 640 })
      const full = webpSize(resolve(fullRoot, `${id}.webp`))
      expect(full.width, `${id} 艺术集宽度不足`).toBeGreaterThanOrEqual(1000)
      expect(full.height, `${id} 艺术集高度不足`).toBeGreaterThanOrEqual(1300)
    }
  })

  it('标准化脚本锁定 Lanczos、WebP q84 与压缩级别 6', () => {
    const script = readFileSync(resolve('scripts/prepare-sanguosha-portraits.ps1'), 'utf8')
    expect(script).toContain('scale=480:640:flags=lanczos')
    expect(script).toContain('-quality 84')
    expect(script).toContain('-compression_level 6')
  })
})
