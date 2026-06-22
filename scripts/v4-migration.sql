-- v4 Phase 4 Migration: Goals, Personal Goals, Weekly Focus, Goal Notifications

-- Admin-set goals per rep
CREATE TABLE IF NOT EXISTS goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id uuid REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  metric text NOT NULL CHECK (metric IN ('leads_won','leads_contacted','proposals_sent','conversion_rate')),
  target numeric NOT NULL,
  period text NOT NULL CHECK (period IN ('weekly','monthly','quarterly')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz DEFAULT now()
);

-- Rep-created personal goals
CREATE TABLE IF NOT EXISTS personal_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id uuid REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  metric text NOT NULL CHECK (metric IN ('leads_won','leads_contacted','proposals_sent','conversion_rate')),
  target numeric NOT NULL,
  period text NOT NULL CHECK (period IN ('weekly','monthly','quarterly')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Weekly focus input per rep (keyed by Monday of the week)
CREATE TABLE IF NOT EXISTS weekly_focus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  focus text NOT NULL,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, week_start)
);

-- In-app goal notifications per rep
CREATE TABLE IF NOT EXISTS goal_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id uuid REFERENCES users(id) ON DELETE CASCADE,
  goal_id uuid REFERENCES goals(id) ON DELETE CASCADE,
  message text NOT NULL,
  is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goals_rep_id ON goals(rep_id);
CREATE INDEX IF NOT EXISTS idx_personal_goals_rep_id ON personal_goals(rep_id);
CREATE INDEX IF NOT EXISTS idx_weekly_focus_user_week ON weekly_focus(user_id, week_start);
CREATE INDEX IF NOT EXISTS idx_goal_notifications_rep ON goal_notifications(rep_id, is_read);
