CREATE TABLE IF NOT EXISTS room_directory (
  code TEXT PRIMARY KEY,
  host_nickname TEXT NOT NULL,
  players_json TEXT NOT NULL,
  occupied_seats INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('finite', 'unlimited')),
  initial_points INTEGER NOT NULL,
  claim_window_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_room_directory_updated
ON room_directory (updated_at DESC);
