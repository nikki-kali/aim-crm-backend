-- Run this in Supabase SQL Editor before starting the backend

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  name text DEFAULT '',
  role text DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text,
  added int DEFAULT 0,
  skipped int DEFAULT 0,
  imported_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);
