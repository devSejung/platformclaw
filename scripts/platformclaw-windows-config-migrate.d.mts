export type WindowsPreviewConfigMigrationResult = {
  migrated: boolean;
  changes: string[];
};

export function migrateWindowsPreviewConfig(
  configPath: string,
): Promise<WindowsPreviewConfigMigrationResult>;
