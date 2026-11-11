-- Mix tab state kept per playlist track:
--   playlist_tracks.locked — the track keeps its position when swapping/dragging
--   playlist_tracks.block  — consecutive tracks sharing a number move as one block
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE playlist_tracks ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE playlist_tracks ADD COLUMN IF NOT EXISTS block  INTEGER;
