// Uploaded archives are an explicit operator-enabled surface. Keep its larger
// package contract isolated from the stricter defaults used by other installers.
export const UPLOADED_SKILL_ARCHIVE_MAX_BYTES = 500 * 1024 * 1024;
export const UPLOADED_SKILL_ARCHIVE_MAX_ENTRIES = 2_000;
export const UPLOADED_SKILL_ARCHIVE_MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
export const UPLOADED_SKILL_ARCHIVE_MAX_ENTRY_BYTES = 250 * 1024 * 1024;
