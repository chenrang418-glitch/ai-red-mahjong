CREATE TABLE IF NOT EXISTS sanguosha_room_directory (
  code TEXT PRIMARY KEY,
  phase TEXT NOT NULL CHECK (phase IN ('lobby', 'playing', 'finished')),
  host_nickname TEXT NOT NULL,
  players_json TEXT NOT NULL,
  occupied_seats INTEGER NOT NULL,
  player_count INTEGER NOT NULL,
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sanguosha_room_directory_phase_updated
  ON sanguosha_room_directory (phase, updated_at DESC);
