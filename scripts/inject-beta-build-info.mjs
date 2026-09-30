import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const outputDir = resolve(process.env.BETA_BUILD_OUTPUT_DIR || 'dist')
const htmlPath = resolve(outputDir, 'index.html')
const headersPath = resolve(outputDir, '_headers')
const version = process.env.BETA_APP_VERSION?.trim()
const commit = process.env.GIT_COMMIT_SHA?.trim()
const buildTime = process.env.BUILD_TIME?.trim()

if (!version || !commit || !buildTime) {
  throw new Error('BETA_APP_VERSION, GIT_COMMIT_SHA, and BUILD_TIME are required for a Beta build.')
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

const html = await readFile(htmlPath, 'utf8')
const commitShort = commit.slice(0, 8)
const banner = `<aside class="crplay-beta-banner" role="status" aria-label="测试版提示"><style>.crplay-beta-banner{box-sizing:border-box;position:relative;z-index:2147483000;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:.3rem .75rem;width:100%;padding:.45rem .75rem;background:#7c2d12;color:#fff7ed;border-bottom:2px solid #fb923c;font:600 12px/1.4 system-ui,sans-serif;text-align:center}.crplay-beta-banner strong{font-weight:800}.crplay-beta-banner a{color:#fff7ed;text-decoration:underline;text-underline-offset:2px}</style><strong>⚠ CRPlay 测试版 Beta</strong><span>功能和数据仅用于测试</span><span>版本 ${escapeHtml(version)}</span><span>提交 ${escapeHtml(commitShort)}</span><time datetime="${escapeHtml(buildTime)}">构建 ${escapeHtml(buildTime)}</time><a href="https://crplay.cn/">正式版</a></aside>`

if (!/<body\b[^>]*>/i.test(html)) {
  throw new Error('Built index.html has no body element; cannot safely add the Beta warning.')
}

await writeFile(htmlPath, html.replace(/(<body\b[^>]*>)/i, `$1${banner}`), 'utf8')

const headers = await readFile(headersPath, 'utf8')
const htmlCacheRule = '\n/\n  Cache-Control: no-cache, must-revalidate\n\n/index.html\n  Cache-Control: no-cache, must-revalidate\n'
if (!headers.includes('Cache-Control: no-cache, must-revalidate')) {
  await writeFile(headersPath, `${headers.trimEnd()}${htmlCacheRule}`, 'utf8')
}

console.log(`Injected Beta banner for ${version} (${commitShort}).`)
