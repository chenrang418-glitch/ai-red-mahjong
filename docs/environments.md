# 部署环境

## Production

- Git 分支：`main`
- 前端：`https://crplay.cn`
- Cloudflare Pages 项目：`ai-red-mahjong`
- API Worker：`ai-red-mahjong-online`
- D1：现有 `ai-red-mahjong`
- Durable Objects：由生产 Worker 绑定的麻将房间、大厅和三国杀房间命名空间
- 自动部署：现有 `.github/workflows/deploy-cloudflare-pages.yml`，仅由 `main` 推送触发

## Beta

- Git 分支：`dev`
- 前端：`https://test.crplay.cn`
- Cloudflare Pages 项目：`crplay-beta-pages`
- API Worker：`crplay-beta-api`，关闭公开 `workers.dev` 入口，通过 Beta Pages service binding 调用
- D1：`crplay-beta-db`，使用 `server/migrations/` 初始化，不复制生产用户数据
- Durable Objects：由 `crplay-beta-api` 的独立 Worker namespace 提供；不得绑定生产 Worker 的 namespace
- 自动部署：`.github/workflows/deploy-cloudflare-beta.yml`，仅由 `dev` 推送触发
- 发布步骤：检查与构建通过后，先将迁移应用到 Beta D1，再部署 Beta Worker 和 Beta Pages
- 构建元数据由 `scripts/inject-beta-build-info.mjs` 写入 Beta 静态入口；横幅显示 Beta 提醒、版本、提交短 SHA 和构建时间

Beta Pages 通过 `wrangler.beta.jsonc` 只绑定 `crplay-beta-api`。Beta Worker 的数据库、房间、大厅和三国杀房间状态必须与 Production 完全分开。不要将生产数据或 Secret 复制到 Beta。

## Local

- 前端：`npm run dev`
- 本地联机 Worker：`npm run dev:online`，默认 `127.0.0.1:8787`
- 本地 API 地址示例：`.env.example` 中的 `VITE_ONLINE_API_BASE=http://127.0.0.1:8787`
- 本地 D1：Wrangler local D1，由 `npm run db:migrate:local` 初始化

## 发布规则

```text
feature/* -> dev -> Beta 自动部署 -> 真机验收 -> 经用户明确要求后才合并/发布到 main
```

`dev` 自动部署不得调用生产 Worker 配置、生产 D1 ID、生产 Durable Objects 或生产域名。不得从 `dev` 自动同步到 `main`。
