-- ============================================================
-- AIM DENTAL CRM v3.0 — Full Migration
-- Run in Supabase SQL Editor
-- ============================================================

-- ── 1. UPDATE leads table ────────────────────────────────────
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS is_archived boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS converted_to_client_id uuid,
  ADD COLUMN IF NOT EXISTS clinic_id uuid;

-- ── 2. UPDATE clients table ──────────────────────────────────
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS original_lead_id uuid,
  ADD COLUMN IF NOT EXISTS clinic_id uuid,
  ADD COLUMN IF NOT EXISTS lead_source text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS email text;

-- ── 3. UPDATE cases table ────────────────────────────────────
-- Drop old status constraint if exists, then update
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS patient text,
  ADD COLUMN IF NOT EXISTS assigned_technician text,
  ADD COLUMN IF NOT EXISTS tracking_number text,
  ADD COLUMN IF NOT EXISTS est_completion_date date,
  ADD COLUMN IF NOT EXISTS stage_history jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS email_log jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS clinic_id uuid,
  ADD COLUMN IF NOT EXISTS doctor_email text,
  ADD COLUMN IF NOT EXISTS doctor_phone text;

-- Migrate existing status values to new 8-stage pipeline
UPDATE cases SET status = 'Case Received'   WHERE status = 'Pending';
UPDATE cases SET status = 'In Production'   WHERE status = 'In Production';
UPDATE cases SET status = 'Completed'       WHERE status = 'Delivered';

-- ── 4. CREATE clinics table ──────────────────────────────────
CREATE TABLE IF NOT EXISTS clinics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  brand text DEFAULT 'Aim Dental',
  address text,
  phone text,
  email text,
  website text,
  lead_source text,
  notes text,
  notification_prefs jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── 5. CREATE activities table ───────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('lead','client','case','clinic')),
  entity_id uuid NOT NULL,
  type text NOT NULL,
  description text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz DEFAULT now()
);

-- ── 6. CREATE tasks table ────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text CHECK (entity_type IN ('lead','client','case','clinic')),
  entity_id uuid,
  title text NOT NULL,
  notes text,
  due_date date,
  completed boolean DEFAULT false,
  completed_at timestamptz,
  assigned_to uuid REFERENCES users(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz DEFAULT now()
);

-- ── 7. CREATE email_templates table ─────────────────────────
CREATE TABLE IF NOT EXISTS email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage text NOT NULL UNIQUE,
  subject text NOT NULL,
  body_html text NOT NULL,
  enabled boolean DEFAULT true,
  updated_at timestamptz DEFAULT now()
);

-- Insert default templates for all 8 stages
INSERT INTO email_templates (stage, subject, body_html) VALUES
  ('Case Received',       'Case #{{case_number}} Received — {{case_type}}',          '<p>Dear Dr. {{doctor_name}},</p><p>We have received your case <strong>{{case_number}}</strong> ({{case_type}}) for patient <strong>{{patient}}</strong>. Our team will review it shortly.</p><p>Expected timeline: {{due_date}}</p>'),
  ('Awaiting Scan',       'Action Required — Missing Files for Case #{{case_number}}','<p>Dear Dr. {{doctor_name}},</p><p>We are missing files or impressions for case <strong>{{case_number}}</strong>. Please send the required materials at your earliest convenience to avoid delays.</p>'),
  ('Case Accepted',       'Case #{{case_number}} Accepted & Queued',                  '<p>Dear Dr. {{doctor_name}},</p><p>Great news — case <strong>{{case_number}}</strong> has been accepted and is queued for production. Estimated start: <strong>{{est_completion_date}}</strong>.</p>'),
  ('In Production',       'Case #{{case_number}} is Now In Production',               '<p>Dear Dr. {{doctor_name}},</p><p>Your case <strong>{{case_number}}</strong> for patient <strong>{{patient}}</strong> has entered production. Assigned technician: <strong>{{assigned_technician}}</strong>. Estimated completion: <strong>{{est_completion_date}}</strong>.</p>'),
  ('Quality Control',     'Case #{{case_number}} — Final Quality Check in Progress',  '<p>Dear Dr. {{doctor_name}},</p><p>Case <strong>{{case_number}}</strong> is undergoing final quality control. Expected dispatch date: <strong>{{due_date}}</strong>.</p>'),
  ('Ready for Dispatch',  'Case #{{case_number}} Ready for Shipment',                 '<p>Dear Dr. {{doctor_name}},</p><p>Case <strong>{{case_number}}</strong> for patient <strong>{{patient}}</strong> ({{case_type}}) is complete and ready for shipment. We will notify you with tracking details once dispatched.</p>'),
  ('Dispatched',          'Case #{{case_number}} Dispatched — Tracking #{{tracking_number}}', '<p>Dear Dr. {{doctor_name}},</p><p>Your case <strong>{{case_number}}</strong> has been dispatched. Tracking number: <strong>{{tracking_number}}</strong>. Estimated delivery: <strong>{{due_date}}</strong>.</p>'),
  ('Completed',           'Case #{{case_number}} Delivered — Thank You!',             '<p>Dear Dr. {{doctor_name}},</p><p>Case <strong>{{case_number}}</strong> has been marked as delivered on <strong>{{completed_date}}</strong>. Thank you for choosing {{brand}}. We look forward to serving you again.</p>')
ON CONFLICT (stage) DO NOTHING;

-- ── 8. CREATE clinic_notification_prefs table ────────────────
CREATE TABLE IF NOT EXISTS clinic_notification_prefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  stage text NOT NULL,
  enabled boolean DEFAULT true,
  UNIQUE(clinic_id, stage)
);

-- ── 9. INDEXES ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_tasks_entity ON tasks(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_leads_archived ON leads(is_archived);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
