export const repoRoot: string;
export function resolveRepoPath(relativePath: string): string;
export function requirePath(relativePath: string): string;
export function readText(relativePath: string): string;
export function readJsonYaml(relativePath: string): unknown;
export function listFiles(relativePath: string): string[];
export function runNodeScript(relativePath: string, args?: string[]): void;
export function runCommand(executable: string, args: string[]): string;
export function printSuccess(label: string, details?: string): void;
