-- Real OAuth connections for Marketing OS's Content Studio Settings page
-- ("Account connections" section) — Instagram (via a Meta app), X, and
-- LinkedIn only for now, matching the three platforms with real
-- developer apps/credentials as of this migration. `platform`'s check
-- constraint deliberately does not pre-declare facebook/threads/tiktok/gbp
-- slots for integrations that don't exist yet; extending the constraint
-- is a one-line follow-up whenever one of those gets built for real.
--
-- One row per (lab, platform) — each brand (aim/kh) connects its own
-- separate business account per platform, same aim/kh split every other
-- per-brand table in this schema already uses.
--
-- access_token_enc/refresh_token_enc are ciphertext (see
-- src/utils/tokenCipher.js) — this schema has no prior "encrypt before
-- storing" column, since nothing stored here before was a live credential
-- capable of posting to a real external account on the lab's behalf.
--
-- Run in Supabase SQL Editor against the live project
-- (dxpwfsyqmxdvnojgetpr) — no Supabase MCP access from this session, so
-- this one has to be applied by hand, same as v8's own note would say if
-- MCP hadn't been available for it.

create table if not exists social_connections (
  id uuid primary key default gen_random_uuid(),
  lab text not null check (lab in ('aim', 'kh')),
  platform text not null check (platform in ('instagram', 'x', 'linkedin')),
  account_id text not null,
  account_name text not null,
  access_token_enc text not null,
  refresh_token_enc text,
  token_expires_at timestamptz,
  scopes text,
  connected_by text not null default 'Admin',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lab, platform)
);

create index if not exists social_connections_lab_idx on social_connections (lab);

-- Drives jobs/socialTokenRefresh.js's scan directly.
create index if not exists social_connections_refresh_idx on social_connections (token_expires_at)
  where refresh_token_enc is not null;

create or replace function set_social_connections_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists social_connections_set_updated_at on social_connections;
create trigger social_connections_set_updated_at
  before update on social_connections
  for each row execute function set_social_connections_updated_at();
