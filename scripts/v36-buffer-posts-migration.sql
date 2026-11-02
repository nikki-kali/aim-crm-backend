-- v36: one row per approved post per platform that the buffer-publish job has
-- sent to Buffer (src/jobs/bufferPublish.js). The unique key is what stops a
-- post from being queued twice. status: queued | withdrawn | error.
create table if not exists buffer_posts (
  id              serial primary key,
  post_id         text not null,
  platform        text not null,
  due_at          timestamptz not null,
  buffer_post_id  text,
  status          text not null check (status in ('queued', 'withdrawn', 'error')),
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (post_id, platform)
);

-- The Nov 3 Instagram post was queued by hand through the API on 2026-11-03.
insert into buffer_posts (post_id, platform, due_at, buffer_post_id, status)
values ('nov03', 'instagram', '2026-11-03T17:30:00Z', '6ae8de943d0f5b43eee189b1', 'queued')
on conflict (post_id, platform) do nothing;

-- A post goes to Buffer only once it is approved AND a signed-in Marketing OS
-- user has clicked "Queue in Buffer" on /content-approvals. Approvals stay
-- open to anyone with the link, so an approval alone never publishes.
create table if not exists buffer_releases (
  post_id         text primary key,
  released_by     text not null,
  released_by_id  text,
  released_at     timestamptz not null default now()
);

-- Set when a queued post's approval changed afterwards and media@ was told.
alter table buffer_posts add column if not exists approval_alerted_at timestamptz;

insert into buffer_releases (post_id, released_by)
values ('nov03', 'AIM Marketing (queued by hand)')
on conflict (post_id) do nothing;
