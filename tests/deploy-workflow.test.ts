import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('生产部署顺序', () => {
  it('只有 verify 全部完成后才进入不可取消的 deploy', () => {
    const workflow = readFileSync('.github/workflows/deploy-cloudflare-pages.yml', 'utf8')
    const verifyAt = workflow.indexOf('  verify:')
    const deployAt = workflow.indexOf('  deploy:')
    expect(verifyAt).toBeGreaterThan(-1)
    expect(deployAt).toBeGreaterThan(verifyAt)
    const deploy = workflow.slice(deployAt)
    expect(deploy).toContain('needs: verify')
    expect(deploy).toContain('cancel-in-progress: false')
    expect(workflow.indexOf('npm run build\n')).toBeLessThan(deployAt)
    expect(deploy.indexOf('preCommands: wrangler d1 migrations apply')).toBeLessThan(deploy.indexOf('command: pages deploy'))
  })
})
