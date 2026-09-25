-- One row per scheduled job per (Eastern) day, so the built-in cron and an
-- external timer hitting POST /api/cron/:job can't both run the same job
-- (which would email the same approval preview twice). Applied by hand,
-- like the other v*-migration.sql files.
CREATE TABLE IF NOT EXISTS cron_job_runs (
  job        text        NOT NULL,
  run_date   date        NOT NULL,
  source     text,
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job, run_date)
);
