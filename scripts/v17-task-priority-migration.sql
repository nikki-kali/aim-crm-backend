-- Adds a priority level to tasks so they can be triaged (used by My Tasks,
-- the Clients page Tasks tab, and the admin-dashboard task creation flow).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority text DEFAULT 'normal'
  CHECK (priority IN ('low', 'normal', 'high'));
