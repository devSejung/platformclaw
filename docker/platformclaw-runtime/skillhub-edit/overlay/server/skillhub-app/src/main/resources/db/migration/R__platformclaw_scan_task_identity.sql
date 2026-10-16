-- Repair in-flight v0.2.16 scan state before consumers start. Older Redis task
-- IDs have no authoritative audit binding; replace them with durable bundle jobs.
-- Historical completed and superseded audits remain available as audit history.
ALTER TABLE security_audit ADD COLUMN IF NOT EXISTS platformclaw_failed_at TIMESTAMPTZ;

-- Earlier outbox attempts could exhaust while a private release stayed PUBLISHED.
-- Recover the exact failed task fact without changing released rows or bytes.
UPDATE security_audit a SET platformclaw_failed_at = o.updated_at
FROM scan_task_outbox o
WHERE o.task_id = a.task_id AND o.status = 'FAILED'
  AND a.deleted_at IS NULL AND a.scanned_at IS NULL AND a.platformclaw_failed_at IS NULL;

WITH latest AS (
    SELECT DISTINCT ON (a.skill_version_id, a.scanner_type) a.id
    FROM security_audit a
    WHERE a.deleted_at IS NULL
    ORDER BY a.skill_version_id, a.scanner_type, a.created_at DESC, a.id DESC
)
UPDATE security_audit a SET task_id = 'platformclaw-legacy-' || a.id
FROM latest l, skill_version v
WHERE a.id = l.id AND v.id = a.skill_version_id
  AND a.task_id IS NULL AND a.scanned_at IS NULL
  AND a.scanner_type = 'SKILL_SCANNER'
  AND v.status IN ('SCANNING', 'PUBLISHED', 'UPLOADED', 'PENDING_REVIEW');

INSERT INTO scan_task_outbox
    (task_id, version_id, bundle_key, publisher_id, status, next_attempt_at, metadata)
SELECT a.task_id, v.id, 'packages/' || v.skill_id || '/' || v.id || '/bundle.zip',
       v.created_by, 'PENDING', CURRENT_TIMESTAMP, '{"scannerType":"skill-scanner"}'::jsonb
FROM security_audit a JOIN skill_version v ON v.id = a.skill_version_id
WHERE a.task_id = 'platformclaw-legacy-' || a.id
  AND a.deleted_at IS NULL AND a.scanned_at IS NULL
ON CONFLICT (task_id) DO NOTHING;
