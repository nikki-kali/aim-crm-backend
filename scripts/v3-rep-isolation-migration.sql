-- v3 Rep Isolation Migration
-- Adds assigned_to (user ID) to leads and clients so each sales rep
-- only sees their own records. Admin sees everything.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id) ON DELETE SET NULL;

-- Index for fast per-rep queries
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_clients_assigned_to ON clients(assigned_to);
