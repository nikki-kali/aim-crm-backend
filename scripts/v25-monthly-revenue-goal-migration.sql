-- v25-monthly-revenue-goal-migration.sql
-- Adds 'monthly_revenue' as a valid goals/personal_goals metric (see
-- src/routes/goals.js's computeProgress, added 2026-09-19 for Ben
-- Silberstein's $30K-monthly-revenue-per-rep goal). Same fix pattern as
-- v20's new_doctors/leads_created addition — without this, any attempt
-- to create a monthly_revenue goal fails with a silent
-- constraint-violation 500, the exact latent bug v20 already found and
-- fixed once for leads_created.

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_metric_check;
ALTER TABLE goals ADD CONSTRAINT goals_metric_check
  CHECK (metric IN ('leads_created','leads_won','leads_contacted','proposals_sent','conversion_rate','new_doctors','monthly_revenue'));

ALTER TABLE personal_goals DROP CONSTRAINT IF EXISTS personal_goals_metric_check;
ALTER TABLE personal_goals ADD CONSTRAINT personal_goals_metric_check
  CHECK (metric IN ('leads_created','leads_won','leads_contacted','proposals_sent','conversion_rate','new_doctors','monthly_revenue'));
