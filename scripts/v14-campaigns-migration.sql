-- Real persistence for Marketing OS's Campaigns module (previously
-- 100% local React state in CampaignsContext.jsx, lost on every reload
-- — see CLAUDE.md's Campaigns sub-app section). Same jsonb-for-nested-
-- objects convention content_posts already established: kpi_targets/
-- audience/email/ab_test/scheduling/automation/analytics/activity_log/
-- settings mirror the frontend's own nested campaign shape exactly, so
-- PATCH stays a straight "these top-level keys get overwritten."
--
-- brevo_campaign_id links a row to a real Brevo draft once pushed
-- (routes/brevo.js) — nullable, since most of a campaign's life happens
-- before that push.
--
-- Run in Supabase SQL Editor against the live project (dxpwfsyqmxdvnojgetpr).

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  campaign_id text not null,
  lab text not null check (lab in ('aim', 'kh')),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'active', 'completed', 'archived')),
  type text not null default 'Email',
  owner text not null default 'Admin',
  priority text not null default 'medium',
  created_by text not null default 'Admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null default 'Untitled campaign',
  goal text not null default '',
  description text not null default '',
  objective text not null default 'Generate Leads',
  kpi_targets jsonb not null default '{}'::jsonb,
  audience jsonb not null default '{}'::jsonb,
  email jsonb not null default '{}'::jsonb,
  ab_test jsonb not null default '{}'::jsonb,
  scheduling jsonb not null default '{}'::jsonb,
  automation jsonb not null default '{}'::jsonb,
  analytics jsonb not null default '{}'::jsonb,
  activity_log jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  brevo_campaign_id integer
);

create index if not exists campaigns_lab_idx on campaigns (lab);
create index if not exists campaigns_status_idx on campaigns (status);

create or replace function set_campaigns_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists campaigns_set_updated_at on campaigns;
create trigger campaigns_set_updated_at
  before update on campaigns
  for each row execute function set_campaigns_updated_at();

-- Account-level send controls (frequency cap, suppression windows) —
-- evaluated across every campaign a contact could receive, not a
-- per-campaign field, same reasoning CampaignsSettings.jsx already
-- documents. One row per brand, like content_settings.
create table if not exists campaign_settings (
  lab text primary key check (lab in ('aim', 'kh')),
  frequency_cap jsonb not null default '{}'::jsonb,
  suppression jsonb not null default '{}'::jsonb
);

insert into campaign_settings (lab, frequency_cap, suppression) values
  ('aim', '{"maxEmails":2,"windowDays":7}', '{"postConversionDays":14,"autoSuppressUnengagedDays":180}'),
  ('kh', '{"maxEmails":2,"windowDays":7}', '{"postConversionDays":14,"autoSuppressUnengagedDays":180}')
on conflict (lab) do nothing;
