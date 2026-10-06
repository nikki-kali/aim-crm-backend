-- Shared approval decisions for the October content review (Marketing OS
-- /content-approvals). One row per post. Not run yet: apply to Supabase
-- only after confirmation.
create table if not exists content_approval_decisions (
  post_id     text primary key,
  status      text not null default '' check (status in ('', 'approved', 'edit', 'rejected')),
  feedback    text not null default '',
  reviewer    text not null default '',
  updated_at  timestamptz not null default now()
);
