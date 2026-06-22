-- ================================================================
-- Aim Dental CRM — v5 EOS Migration
-- Run in Supabase SQL Editor
-- ================================================================

-- Rename weekly_focus.focus → focus_text (existing v4 column)
ALTER TABLE weekly_focus RENAME COLUMN focus TO focus_text;
ALTER TABLE weekly_focus ALTER COLUMN focus_text DROP NOT NULL;

-- ── Rocks (90-day priorities) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS rocks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  rock_type TEXT CHECK (rock_type IN ('company','individual','personal')) NOT NULL DEFAULT 'company',
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  quarter TEXT NOT NULL,
  due_date DATE,
  status TEXT CHECK (status IN ('On Track','Off Track','Done')) NOT NULL DEFAULT 'On Track',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Rock Milestones ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rock_milestones (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  rock_id UUID NOT NULL REFERENCES rocks(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  due_date DATE,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Weekly To-Dos ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS weekly_todos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  due_date DATE,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  rock_id UUID REFERENCES rocks(id) ON DELETE SET NULL,
  week_start DATE NOT NULL,
  carried_over BOOLEAN NOT NULL DEFAULT FALSE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Issues List ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS issues (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  raised_by UUID REFERENCES users(id) ON DELETE SET NULL,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  priority TEXT CHECK (priority IN ('High','Medium','Low')) NOT NULL DEFAULT 'Medium',
  status TEXT CHECK (status IN ('Identified','Discussed','Solved')) NOT NULL DEFAULT 'Identified',
  discussion_notes TEXT,
  solution_notes TEXT,
  rock_id UUID REFERENCES rocks(id) ON DELETE SET NULL,
  solved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Issue Comments ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS issue_comments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  comment TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── EOS Notifications (supplemental) ────────────────────────────
-- Primary bell uses the existing alerts table with type='eos_rock'/'eos_issue'/'eos_todo'
CREATE TABLE IF NOT EXISTS eos_notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_rocks_owner ON rocks(owner_id);
CREATE INDEX IF NOT EXISTS idx_rocks_type ON rocks(rock_type);
CREATE INDEX IF NOT EXISTS idx_rock_milestones_rock ON rock_milestones(rock_id);
CREATE INDEX IF NOT EXISTS idx_weekly_todos_owner_week ON weekly_todos(owner_id, week_start);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id);
