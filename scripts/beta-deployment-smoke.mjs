const baseUrl = process.env.BETA_SMOKE_URL?.replace(/\/$/, '')
const expectedCommit = process.env.EXPECTED_COMMIT?.slice(0, 8)

if (!baseUrl || !expectedCommit) {
  throw new Error('BETA_SMOKE_URL and EXPECTED_COMMIT are required.')
}

const pageResponse = await fetch(`${baseUrl}/`, { cache: 'no-store' })
if (!pageResponse.ok) {
  throw new Error(`Beta page returned HTTP ${pageResponse.status}.`)
}

const pageHtml = await pageResponse.text()
for (const expectedText of ['CRPlay 测试版 Beta', '0.9.0-beta', expectedCommit]) {
  if (!pageHtml.includes(expectedText)) {
    throw new Error(`Beta page is missing expected build marker: ${expectedText}.`)
  }
}

const healthResponse = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' })
if (!healthResponse.ok) {
  throw new Error(`Beta API health returned HTTP ${healthResponse.status}.`)
}

const health = await healthResponse.json()
if (health?.ok !== true) {
  throw new Error('Beta API health response did not contain { ok: true }.')
}

console.log(`Beta smoke passed: ${baseUrl} served commit ${expectedCommit} and API health is OK.`)
