-- Real persistence for Content Studio (Marketing OS) — replaces the
-- in-memory-only mock that previously backed ContentContext.jsx. Nested
-- objects stored as jsonb (content/scheduling/approval/analytics/
-- activity_log/per_platform_text) match this schema's own existing
-- convention for structured/append-only data (see e.g. clinics.
-- stage_history) and keep the frontend's existing shallow-merge-per-field
-- update shape translatable directly into "PATCH sets these columns."
--
-- media_storage_path/media_deleted_at back the 30-day cleanup job
-- (src/jobs/mediaCleanup.js): once a published post's media is 30+ days
-- old, only the Storage object gets deleted (media_storage_path -> null,
-- media_deleted_at -> now()) — the row itself, including analytics, is
-- never deleted, since the Content Analytics page (top posts, hashtag
-- performance) needs real historical data to keep working.
--
-- Run in Supabase SQL Editor. Applied directly against the live project
-- (dxpwfsyqmxdvnojgetpr) via the Supabase MCP `apply_migration` tool at
-- the same time this file was checked in.

create table if not exists content_posts (
  id uuid primary key default gen_random_uuid(),
  lab text not null check (lab in ('aim', 'kh')),
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'scheduled', 'published', 'failed')),
  created_by text not null default 'Admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  platforms jsonb not null default '[]'::jsonb,
  content jsonb not null default '{"text":"","hashtags":[],"firstComment":"","mediaType":"none","mediaLabel":"","mediaFileName":""}'::jsonb,
  per_platform_text jsonb not null default '{}'::jsonb,
  scheduling jsonb not null default '{}'::jsonb,
  approval jsonb not null default '{"required":true,"platforms":{}}'::jsonb,
  compliance text not null default 'pass',
  compliance_note text not null default '',
  analytics jsonb,
  published_at date,
  activity_log jsonb not null default '[]'::jsonb,
  media_storage_path text,
  media_deleted_at timestamptz
);

create index if not exists content_posts_lab_idx on content_posts (lab);
create index if not exists content_posts_status_idx on content_posts (status);
-- Drives the media-cleanup job's daily scan directly.
create index if not exists content_posts_media_cleanup_idx on content_posts (published_at)
  where status = 'published' and media_storage_path is not null and media_deleted_at is null;

create or replace function set_content_posts_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists content_posts_set_updated_at on content_posts;
create trigger content_posts_set_updated_at
  before update on content_posts
  for each row execute function set_content_posts_updated_at();

-- One row per brand — small, rarely-changes, included so Content
-- Studio's state is fully real rather than half-real.
create table if not exists content_settings (
  lab text primary key check (lab in ('aim', 'kh')),
  connected_platforms jsonb not null default '[]'::jsonb,
  approval_required boolean not null default true,
  queue_slots jsonb not null default '{}'::jsonb
);
