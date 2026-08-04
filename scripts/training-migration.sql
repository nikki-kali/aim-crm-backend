-- ================================================================
-- Aim Dental CRM — Training Migration
-- Tracks completion of in-app tour modules and Training-tab scenarios
-- per user, so progress syncs across devices and admins can see who's
-- completed what (Users page > Training Progress).
-- ================================================================

CREATE TABLE IF NOT EXISTS training_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('tour', 'scenario')),
  item_id text NOT NULL,
  completed_at timestamptz DEFAULT now(),
  UNIQUE (user_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_training_progress_user ON training_progress(user_id);

-- ================================================================
-- Done!
-- ================================================================
