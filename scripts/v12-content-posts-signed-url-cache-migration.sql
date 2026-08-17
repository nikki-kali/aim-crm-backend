-- Caches the signed Storage URL for a post's media instead of minting a
-- fresh one on every GET /content-posts/:id/media-url call. A brand-new
-- signed token on every call meant the browser could never HTTP-cache
-- the underlying file, so simply reopening a post re-downloaded the
-- full media from Storage every time — traced as the leading driver of
-- the Supabase org's Egress-Exceeded quota overage (grace period until
-- 2026-09-05). Cached alongside media_storage_path; cleared whenever
-- the media itself changes, is removed, or is cleaned up (see
-- jobs/mediaCleanup.js).
--
-- Run in Supabase SQL Editor against the live project (dxpwfsyqmxdvnojgetpr).

alter table content_posts add column if not exists media_signed_url text;
alter table content_posts add column if not exists media_signed_url_expires_at timestamptz;
