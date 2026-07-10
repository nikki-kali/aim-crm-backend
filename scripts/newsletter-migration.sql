-- Dedicated table for website newsletter signups (popup + footer/blog CTA).
-- Kept separate from `leads` since subscribers aren't sales leads — no
-- doctor name, case interest, or scoring applies here, just an email
-- address and where it came from.
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  source TEXT DEFAULT 'website',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
