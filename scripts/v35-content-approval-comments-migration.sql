-- v35-content-approval-comments-migration.sql
-- Comment threads on Marketing OS /content-approvals. Every decision
-- (approve / needs edit / reject) and every piece of feedback is kept as its
-- own dated, named entry instead of overwriting the post's one feedback field;
-- replies (e.g. "fixed, here's what changed") hang off a top-level entry via
-- parent_id. content_approval_decisions still holds each post's current status.
create table if not exists content_approval_comments (
  id          serial primary key,
  post_id     text not null,
  parent_id   integer references content_approval_comments(id) on delete cascade,
  author      text not null,
  author_id   integer,
  -- 'pending' marks a post sent back to pending review after an update.
  status      text not null default '' check (status in ('', 'approved', 'edit', 'rejected', 'pending')),
  body        text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists content_approval_comments_post_idx on content_approval_comments (post_id, created_at);

-- Backfill: each post's existing decision/feedback becomes the first entry in
-- its thread, dated when it was saved. Skips posts that already have a thread,
-- so re-running is harmless.
insert into content_approval_comments (post_id, author, author_id, status, body, created_at)
select d.post_id, d.reviewer, d.reviewer_id, d.status, d.feedback, d.updated_at
from content_approval_decisions d
where (d.status <> '' or d.feedback <> '')
  and not exists (select 1 from content_approval_comments c where c.post_id = d.post_id);
