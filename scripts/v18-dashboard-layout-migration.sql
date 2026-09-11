-- Backend/scripts/v18-dashboard-layout-migration.sql
-- Per-user, per-dashboard widget layout (show/hide + order) for the
-- customizable Dashboard feature. No row = use the hardcoded frontend
-- default (current layout, everything visible, current order).
CREATE TABLE IF NOT EXISTS dashboard_layouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) NOT NULL,
  dashboard_type text NOT NULL CHECK (dashboard_type IN ('rep', 'admin')),
  widgets jsonb NOT NULL,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, dashboard_type)
);
