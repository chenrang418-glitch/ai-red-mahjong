PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_stats (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  seven_pairs INTEGER NOT NULL DEFAULT 0,
  gang_count INTEGER NOT NULL DEFAULT 0,
  ma_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS round_player_results (
  match_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  won INTEGER NOT NULL CHECK (won IN (0, 1)),
  seven_pairs INTEGER NOT NULL CHECK (seven_pairs IN (0, 1)),
  gang_count INTEGER NOT NULL DEFAULT 0,
  ma_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, round_number, user_id)
);

CREATE TRIGGER IF NOT EXISTS update_user_stats_after_round
AFTER INSERT ON round_player_results
BEGIN
  INSERT INTO user_stats (user_id, total_games, wins, seven_pairs, gang_count, ma_count)
  VALUES (NEW.user_id, 1, NEW.won, NEW.seven_pairs, NEW.gang_count, NEW.ma_count)
  ON CONFLICT(user_id) DO UPDATE SET
    total_games = total_games + 1,
    wins = wins + NEW.won,
    seven_pairs = seven_pairs + NEW.seven_pairs,
    gang_count = gang_count + NEW.gang_count,
    ma_count = ma_count + NEW.ma_count;
END;

CREATE INDEX IF NOT EXISTS idx_user_stats_ranking
ON user_stats (wins DESC, total_games DESC, seven_pairs DESC, gang_count DESC, ma_count DESC);
