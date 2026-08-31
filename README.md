# 红中麻将

面向朋友快速开局的网页红中麻将。支持单机 AI 和四人联机，桌面、手机竖屏与手机横屏均以一屏完成核心操作为目标。

生产地址：[https://crplay.cn](https://crplay.cn)

## 本地运行

PowerShell：

```powershell
cd "C:\Users\cr\Documents\work\ai-red-mahjong"
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173`。

联机本地调试需要另开一个 PowerShell：

```powershell
npm run dev:online
```

前端在本地开发时默认连接 `http://127.0.0.1:8787`；生产环境通过同源 `/api/*` 访问 Worker。

> 本地调试联机时必须用 `http://127.0.0.1:5173` 打开页面，不要用 `http://localhost:5173`。
> 会话是 `SameSite=Lax` 的 HttpOnly Cookie，`localhost` 和 `127.0.0.1` 属于不同站点，
> 浏览器不会把 Cookie 带给 `127.0.0.1:8787`，表现为登录后立刻提示「登录状态已失效」。
> 生产环境前后端同源，不存在这个问题。

## 游戏范围

- 112 张牌：万、筒、条各 1～9，每张 4 张，另有 4 张红中。
- 四人、无吃、只能自摸，支持普通胡与七对。
- 红中可作万能牌，但不能碰、明杠、暗杠或补杠。
- 支持碰、明杠、暗杠、补杠、杠后补牌和杠后自摸。
- 最后 6 张为码区；有红中胡抓 4 张，无红中胡抓 6 张。
- 单机牌局仅保存在内存；离开即结束，不提供残局恢复、牌谱或回放。

## 联机架构

- Cloudflare Pages：Vue 3 + TypeScript + Vite 前端。
- Cloudflare Worker：HTTP 与 WebSocket 入口。
- `MahjongRoom` Durable Object：每个房间一份服务端权威状态。
- `MahjongLobby` Durable Object：轻量房间目录广播、会话注册与全局设置。
- D1：昵称、公开房间摘要和管理审计；不保存牌局步骤、聊天或长期战绩。

客户端只提交操作意图。服务端检查回合、版本、`actionId`、合法出牌、碰、杠、胡，并在下发视图时隐藏其他玩家手牌、暗杠和牌墙。

## 会话与分享

昵称登录后，服务端生成高熵随机 opaque session ID，通过 `HttpOnly; SameSite=Lax; Secure` Cookie（本地 HTTP 调试时不加 `Secure`）保存。浏览器脚本不读取 token，WebSocket 地址也不包含 token。

房间分享链接格式：

```text
https://crplay.cn/?room=ABC234
```

已有会话会直接尝试加入；没有会话时输入昵称后自动加入目标房间。

## 数据库迁移

历史 migration 不修改。`0005_remove_player_stats.sql` 删除已废弃的长期战绩表、触发器和索引；`users`、`room_directory` 与 `admin_audit` 保留。

本地应用：

```powershell
npm run db:migrate:local
```

生产迁移由 GitHub Actions 在部署 Worker 前执行。

## 验证

```powershell
npm run test:run
npm run typecheck
npm run typecheck:online
npm run build
npm run build:online
npm run test:online:smoke
npx playwright install chromium
npm run test:e2e
```

Playwright 覆盖 1920×1080、1440×900、1280×720、393×852、430×932、852×393 和 932×430，检查首页、单机设置、牌桌和联机大厅的可见性与页面级溢出。

## 部署

推送 `main` 后，[`.github/workflows/deploy-cloudflare-pages.yml`](.github/workflows/deploy-cloudflare-pages.yml) 依次执行依赖安装、测试、Worker 类型检查与构建、D1 migration、Worker 部署、前端构建和 Pages 部署。

管理员密钥只通过 Cloudflare `ADMIN_TOKEN` secret 配置，不写入仓库。管理入口为 `/#admin`，用于用户最低信息、房间解散、维护模式、托管 AI 默认难度和审计。
