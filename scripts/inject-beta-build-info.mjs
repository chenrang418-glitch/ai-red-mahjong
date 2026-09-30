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
const watermarkText = [
  `CRPlay 测试版 Beta · 功能和数据仅用于测试`,
  `版本 ${version} · 提交 ${commitShort} · 构建 ${buildTime}`,
].map(escapeHtml)
const watermark = `<aside class="crplay-beta-watermark" aria-hidden="true"><style>.crplay-beta-watermark{box-sizing:border-box;position:fixed;z-index:2147483000;inset:-55%;width:210%;height:210%;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));grid-template-rows:repeat(6,minmax(0,1fr));align-items:center;justify-items:center;transform:rotate(-45deg);pointer-events:none;user-select:none;color:rgba(124,45,18,.22);font:700 clamp(12px,1.35vw,18px)/1.65 system-ui,sans-serif;text-align:center;letter-spacing:.035em}.crplay-beta-watermark span{display:block;white-space:nowrap}@media(prefers-reduced-transparency:reduce){.crplay-beta-watermark{color:rgba(124,45,18,.28)}}</style>${Array.from({ length: 30 }, () => `<span>${watermarkText[0]}<br>${watermarkText[1]}</span>`).join('')}</aside>`

if (!/<body\b[^>]*>/i.test(html)) {
  throw new Error('Built index.html has no body element; cannot safely add the Beta warning.')
}

await writeFile(htmlPath, html.replace(/(<body\b[^>]*>)/i, `$1${watermark}`), 'utf8')

const headers = await readFile(headersPath, 'utf8')
const htmlCacheRule = '\n/\n  Cache-Control: no-cache, must-revalidate\n\n/index.html\n  Cache-Control: no-cache, must-revalidate\n'
if (!headers.includes('Cache-Control: no-cache, must-revalidate')) {
  await writeFile(headersPath, `${headers.trimEnd()}${htmlCacheRule}`, 'utf8')
}

console.log(`Injected Beta watermark for ${version} (${commitShort}).`)
