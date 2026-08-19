-- Node 版专属：Cloudflare 那边房间状态和大厅设置存在 Durable Object 的 storage 里，
-- 自建服务器没有这套东西，落到两张键值表上。
-- 放在 server-node/migrations 而不是 server/migrations，是为了不给 D1 那边平白多两张空表。

CREATE TABLE IF NOT EXISTS room_state (
  code TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lobby_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
