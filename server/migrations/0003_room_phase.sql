ALTER TABLE room_directory
ADD COLUMN phase TEXT NOT NULL DEFAULT 'lobby'
CHECK (phase IN ('lobby', 'playing'));

CREATE INDEX IF NOT EXISTS idx_room_directory_phase_updated
ON room_directory (phase, updated_at DESC);
