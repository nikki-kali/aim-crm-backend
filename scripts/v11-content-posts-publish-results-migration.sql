-- Real publishing results for Content Studio posts (routes/contentPosts.js's
-- new POST /content-posts/:id/publish). Same "one jsonb object keyed by
-- platform id" shape this table's own `approval` column already uses for
-- per-platform state, not a new pattern.
--
-- Shape once populated: { [platformId]: { status: 'published'|'failed'|
-- 'skipped', externalId, externalUrl, mediaIncluded, error, publishedAt } }
--
-- Run in Supabase SQL Editor against the live project (dxpwfsyqmxdvnojgetpr).

alter table content_posts add column if not exists publish_results jsonb;
