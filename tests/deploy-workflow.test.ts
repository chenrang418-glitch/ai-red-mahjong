import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('生产部署顺序', () => {
  it('只有 verify 全部完成后才进入不可取消的 deploy', () => {
    const workflow = readFileSync('.github/workflows/deploy-cloudflare-pages.yml', 'utf8')
    const verifyJobs = ['unit', 'frontend', 'online', 'e2e']
    const verifyPositions = verifyJobs.map((job) => workflow.indexOf(`  ${job}:`))
    const deployAt = workflow.indexOf('  deploy:')
    expect(verifyPositions.every((position) => position >= 0)).toBe(true)
    expect(verifyPositions.every((position) => deployAt > position)).toBe(true)
    const deploy = workflow.slice(deployAt)
    for (const job of verifyJobs) expect(deploy).toContain(`      - ${job}`)
    expect(deploy).toContain('cancel-in-progress: false')
    expect(deploy).not.toMatch(/npm run (build|typecheck|test)/)
    expect(deploy).toContain('actions/download-artifact@v4')
    expect(deploy.indexOf('preCommands: wrangler d1 migrations apply')).toBeLessThan(deploy.indexOf('command: pages deploy'))
  })
})
