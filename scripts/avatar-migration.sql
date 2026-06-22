-- Add profile photo column to users (safe / idempotent)
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
