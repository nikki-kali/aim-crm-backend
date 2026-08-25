-- Adds a location field to leads so it can be shown in the weekly
-- unassigned-leads report (and anywhere else that lists a lead) without
-- scraping it out of free-text notes. Nullable/optional — most existing
-- leads won't have one until entered.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS location text;
