import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 几个用例都要跑真正打包出来的 Worker。以前是各自在 beforeAll 里构建一次，
// 但它们并行跑、写的又是同一个 server/dist/worker.js，会互相打架。
// 统一在这里构建一次，所有测试文件共用产物。
export default function setup() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  execSync('npx vite build --config server/vite.config.ts --configLoader runner', { cwd: root, stdio: 'pipe' })
}
