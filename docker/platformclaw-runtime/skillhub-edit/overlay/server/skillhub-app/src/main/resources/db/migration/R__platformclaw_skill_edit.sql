-- Additive downstream surface; published package files and IDs remain unchanged.
ALTER TABLE skill ADD COLUMN IF NOT EXISTS platformclaw_managed_metadata BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE skill ADD COLUMN IF NOT EXISTS platformclaw_requested_visibility VARCHAR(20);
CREATE TABLE IF NOT EXISTS platformclaw_skill_edit_receipt (
    operation_id VARCHAR(36) PRIMARY KEY,
    request_hash VARCHAR(64) NOT NULL,
    result_json TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
