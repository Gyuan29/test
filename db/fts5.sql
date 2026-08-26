-- Apply after the organizations table exists.
CREATE INDEX IF NOT EXISTS idx_organizations_name ON organizations(name);
CREATE INDEX IF NOT EXISTS idx_organizations_description ON organizations(description);
CREATE INDEX IF NOT EXISTS idx_organizations_summary ON organizations(summary);
CREATE INDEX IF NOT EXISTS idx_organizations_context ON organizations(context);
