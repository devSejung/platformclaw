-- Runs after the retained skill-edit table owner on clean databases.
-- Historical edit receipts contain descriptions. Erase them at the same durable
-- boundary that confirms physical removal; retain only minimal native audit facts.
-- The existing cleanup owner's one-year receipt expiry also expires those facts.
CREATE OR REPLACE FUNCTION platformclaw_artifact_history_retention()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.platformclaw_whole_skill AND OLD.status = 'COMPLETED'
           AND OLD.updated_at <= CURRENT_TIMESTAMP - INTERVAL '365 days' THEN
            DELETE FROM audit_log
            WHERE lower(target_type) = 'skill' AND target_id = OLD.skill_id
              AND created_at <= OLD.updated_at;
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.platformclaw_whole_skill AND NEW.status = 'COMPLETED' THEN
        -- Older completed partial cleanups retained filenames and error payloads.
        -- Updating only payload columns preserves expiry and cannot retrigger status.
        UPDATE skill_storage_delete_compensation
        SET namespace = '', slug = '', storage_keys_json = '[]', last_error = NULL
        WHERE skill_id = NEW.skill_id AND status = 'COMPLETED';
        DELETE FROM platformclaw_skill_edit_receipt
        WHERE result_json::jsonb ->> 'id' = NEW.skill_id::text;
        UPDATE audit_log
        SET detail_json = NULL, client_ip = NULL, user_agent = NULL, request_id = NULL
        WHERE lower(target_type) = 'skill' AND target_id = NEW.skill_id
          AND created_at <= NEW.updated_at;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platformclaw_artifact_history_completed ON skill_storage_delete_compensation;
CREATE TRIGGER platformclaw_artifact_history_completed
    AFTER INSERT OR UPDATE OF status ON skill_storage_delete_compensation
    FOR EACH ROW EXECUTE FUNCTION platformclaw_artifact_history_retention();
DROP TRIGGER IF EXISTS platformclaw_artifact_history_expired ON skill_storage_delete_compensation;
CREATE TRIGGER platformclaw_artifact_history_expired
    BEFORE DELETE ON skill_storage_delete_compensation
    FOR EACH ROW EXECUTE FUNCTION platformclaw_artifact_history_retention();

-- Upgrade an already-completed task using its original completion timestamp.
UPDATE skill_storage_delete_compensation compensation
SET namespace = '', slug = '', storage_keys_json = '[]', last_error = NULL
WHERE compensation.status = 'COMPLETED' AND EXISTS (
    SELECT 1 FROM skill_storage_delete_compensation deletion
    WHERE deletion.skill_id = compensation.skill_id
      AND deletion.platformclaw_whole_skill AND deletion.status = 'COMPLETED'
);
DELETE FROM platformclaw_skill_edit_receipt edit
USING skill_storage_delete_compensation deletion
WHERE deletion.platformclaw_whole_skill AND deletion.status = 'COMPLETED'
  AND edit.result_json::jsonb ->> 'id' = deletion.skill_id::text;
UPDATE audit_log audit
SET detail_json = NULL, client_ip = NULL, user_agent = NULL, request_id = NULL
FROM skill_storage_delete_compensation deletion
WHERE deletion.platformclaw_whole_skill AND deletion.status = 'COMPLETED'
  AND lower(audit.target_type) = 'skill' AND audit.target_id = deletion.skill_id
  AND audit.created_at <= deletion.updated_at;
