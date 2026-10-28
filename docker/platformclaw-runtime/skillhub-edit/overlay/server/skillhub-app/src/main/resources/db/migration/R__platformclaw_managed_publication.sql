-- Managed identity commits before object writes so failed uploads remain erasable.
ALTER TABLE skill
    ADD COLUMN IF NOT EXISTS platformclaw_managed_publication_id VARCHAR(36);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platformclaw_managed_publication
    ON skill (platformclaw_managed_publication_id)
    WHERE platformclaw_managed_publication_id IS NOT NULL;
