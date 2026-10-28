-- Existing compensation includes partial-version cleanup; it is never whole-delete proof.
ALTER TABLE skill_storage_delete_compensation
    ADD COLUMN IF NOT EXISTS platformclaw_whole_skill BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_platformclaw_whole_skill_deletion
    ON skill_storage_delete_compensation (skill_id) WHERE platformclaw_whole_skill;
