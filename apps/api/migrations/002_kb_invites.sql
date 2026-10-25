-- KB-scoped invites: pulling people outside the org into the org as members
-- with a knowledge-base grant, or granting on acceptance after registration.
ALTER TABLE invites
  ADD COLUMN IF NOT EXISTS kb_id uuid REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS kb_permission text
    CHECK (kb_permission IS NULL OR kb_permission IN ('viewer', 'editor', 'manager'));

CREATE INDEX IF NOT EXISTS invites_kb_idx ON invites(kb_id);
