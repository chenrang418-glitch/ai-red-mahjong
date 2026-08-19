# 联机服务（Node 版）

从 Cloudflare Worker + Durable Objects + D1 迁移过来的自建版本。
**HTTP 接口、WebSocket 消息、关闭码、房间逻辑全部保持不变**，前端不用改任何协议相关的代码。

## 为什么能这么省事

| Cloudflare | 这边怎么替代 | 代码改动 |
|---|---|---|
| Worker `fetch` 路由 | Node `http` + 全局 `Request`/`Response` 桥接 | 路由逻辑原样搬 |
| D1 (`prepare/bind/run/all`) | `src/db.ts` 里实现同样的接口，底层 `node:sqlite` | **零改动**，三十多处 SQL 调用不用动 |
| Durable Object（房间） | `src/rooms.ts`：Map 装实例 + SQLite 存快照 + `setTimeout` 当 alarm | 方法搬过来，改三处 API |
| DO WebSocket（hibernation） | `ws` 库 | 唯一真正重写的部分 |
| DO storage（大厅设置、会话） | `src/lobby.ts` + `lobby_state` 键值表 | 逻辑照搬 |

**麻将规则和房间逻辑一行没改**：`server/room-core.ts`（975 行，含 AI 托管、定时任务、座位管理）
和 `src/game/*` 都是直接 import 的，两个后端共用同一份源码。

## 本地跑

```bash
cd server-node
npm install
npm run build
ADMIN_TOKEN=随便一段长字符串 npm start
```

默认监听 `8787`，数据库落在 `server-node/data/mahjong.db`。首次启动会自动执行迁移。

验收：

```bash
ADMIN_TOKEN=随便一段长字符串 node smoke.mjs
```

会走一遍完整流程：登录、建房、两人入座、聊天、开局补 AI、断线重连、
三个自定义关闭码（4001 房间拒绝 / 4002 管理员解散 / 4003 顶号）、管理接口、维护模式。

## 服务器部署

首次：

```bash
git clone <仓库地址> /opt/ai-red-mahjong
cd /opt/ai-red-mahjong/server-node
npm ci
npm run build
cp .env.example .env && vi .env      # 填 ADMIN_TOKEN
pm2 start ecosystem.config.js
pm2 save
```

之后每次更新：

```bash
cd /opt/ai-red-mahjong && git pull
cd server-node && npm ci && npm run build
pm2 reload ai-red-mahjong
```

`npm ci` 装的是纯 JS 依赖（只有 `ws`），**没有原生模块**，服务器上不需要编译工具链。
SQLite 用的是 Node 24 自带的 `node:sqlite`。

### Nginx

WebSocket 必须带 Upgrade 头，另外 `proxy_read_timeout` 要放长，
否则空闲的牌局连接会被 Nginx 主动掐断（客户端心跳是 30 秒一次）。

```nginx
server {
    listen 443 ssl http2;
    server_name 你的域名;

    ssl_certificate     /etc/letsencrypt/live/你的域名/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/你的域名/privkey.pem;

    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;

        # WebSocket 升级
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 牌局中途会有长时间没消息的空档，别让 Nginx 提前断开
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

`$connection_upgrade` 需要在 `http` 段里定义：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

## 注意事项

- **必须单进程**（PM2 用 `fork` 而不是 `cluster`）。房间状态在进程内存里，
  多实例会各自持有一份，同一个房间号会分裂成两桌。要横向扩展得先把房间状态挪到 Redis 之类的外部存储。
- 进程重启后房间会从 `room_state` 表恢复，正在打的牌局不会因为一次部署丢掉。
- `ADMIN_TOKEN` 不配的话，`/api/admin/*` 整体返回 404——不是 401，
  免得别人从状态码判断出「这里有管理入口」。
- 数据库文件在 `data/`，已经 gitignore。备份直接拷这个目录即可（WAL 模式下要连 `-wal` 和 `-shm` 一起拷，或者先停服务）。
