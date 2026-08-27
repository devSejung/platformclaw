const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".clawhub",
  ".clawdhub",
  ".openclaw",
  ".ssh",
  "node_modules",
  "__pycache__",
]);
const EXCLUDED_FILES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "authorized_keys",
  "known_hosts",
  "credentials",
  "credentials.json",
  "secrets",
  "secrets.json",
]);
const EXCLUDED_FILE_SUFFIXES = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".crt",
  ".cer",
  ".cert",
  ".der",
];

/** Returns true for runtime state, VCS data, dependency trees, and likely credentials. */
export function isExcludedSkillArchivePath(entryPath: string, directory: boolean): boolean {
  const components = entryPath.toLowerCase().replace(/\/$/u, "").split("/");
  const basename = components.at(-1) ?? "";
  if (components.some((part) => EXCLUDED_DIRECTORIES.has(part))) {
    return true;
  }
  if (directory) {
    return EXCLUDED_DIRECTORIES.has(basename);
  }
  return (
    EXCLUDED_FILES.has(basename) ||
    EXCLUDED_FILE_SUFFIXES.some((suffix) => basename.endsWith(suffix))
  );
}
