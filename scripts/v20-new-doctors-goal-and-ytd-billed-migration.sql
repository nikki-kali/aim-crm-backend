-- v20-new-doctors-goal-and-ytd-billed-migration.sql
-- Two independent additive changes, bundled per
-- docs/superpowers/specs/2026-09-15-sales-rep-daily-and-leadership-report-design.md:
--  1. Adds 'new_doctors' as a valid goals/personal_goals metric, for the
--     Sales Rep Daily Report's weekly new-doctor goal (src/routes/goals.js).
--  2. Adds evident_report_log.ytd_billed_value, for the Leadership
--     Report's new Yearly Billed tile.
--
-- Also folds in 'leads_created': it was added as a goals.js metric branch
-- and a Frontend goal option back in commit c0561cf ("Support
-- leads_created as a goal metric"), but the matching CHECK constraint
-- update was never shipped — confirmed live that zero goals/personal_goals
-- rows exist with this metric in production, meaning every "Leads Added"
-- goal anyone has tried to create since has failed with a silent
-- constraint-violation 500. Fixed here since this exact statement is
-- already being rewritten for new_doctors; flagged to the user separately
-- since it's outside this task's original scope.

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_metric_check;
ALTER TABLE goals ADD CONSTRAINT goals_metric_check
  CHECK (metric IN ('leads_created','leads_won','leads_contacted','proposals_sent','conversion_rate','new_doctors'));

ALTER TABLE personal_goals DROP CONSTRAINT IF EXISTS personal_goals_metric_check;
ALTER TABLE personal_goals ADD CONSTRAINT personal_goals_metric_check
  CHECK (metric IN ('leads_created','leads_won','leads_contacted','proposals_sent','conversion_rate','new_doctors'));

ALTER TABLE evident_report_log ADD COLUMN IF NOT EXISTS ytd_billed_value numeric NOT NULL DEFAULT 0;
