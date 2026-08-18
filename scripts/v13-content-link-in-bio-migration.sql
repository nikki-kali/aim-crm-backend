-- Real persistence for Content Studio's Link in Bio page (Marketing OS)
-- — previously local-only React state seeded from a frontend mock file,
-- lost on every reload. One row per brand, same shape as content_settings.
--
-- handle/bio_line are seeded with the labs' real existing handles/taglines
-- (not fabricated data — same values already used elsewhere in the app);
-- links starts empty and page_views_30d starts at 0 rather than carrying
-- forward the old mock's invented click/view counts, since there's no real
-- tracking infrastructure behind those numbers yet.
--
-- Run in Supabase SQL Editor against the live project (dxpwfsyqmxdvnojgetpr).

create table if not exists content_link_in_bio (
  lab text primary key check (lab in ('aim', 'kh')),
  handle text not null default '',
  bio_line text not null default '',
  links jsonb not null default '[]'::jsonb,
  page_views_30d integer not null default 0
);

insert into content_link_in_bio (lab, handle, bio_line) values
  ('aim', '@aimdentallab', 'Precision Crafted. Delivered on Time.'),
  ('kh', '@kingshighwaydental', 'Precision Dental Restorations')
on conflict (lab) do nothing;
