import {
  buildRemoteCommand,
  disposeSshSandboxSession,
  runSshSandboxCommand,
  type SandboxBackendSkillCatalog,
  type SandboxBackendSkillFile,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import type { AssignedVmTargetSnapshot } from "./backend.js";

type RemoteSkillIo = {
  createSession: (target: AssignedVmTargetSnapshot) => Promise<SshSandboxSession>;
  disposeSession: typeof disposeSshSandboxSession;
  runCommand: typeof runSshSandboxCommand;
};

type RemoteSkillTimingOptions = {
  logTiming?: (message: string) => void;
  now?: () => number;
};

const MAX_SKILLS = 128;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CACHED_TARGETS = 256;
const SCAN_TIMEOUT_MS = 15_000;
const SKILL_SOURCES = new Set([
  "platformclaw-vm-workspace",
  "platformclaw-vm-managed",
  "platformclaw-vm-bundled",
]);

export const VM_REMOTE_SKILL_SCAN_SCRIPT = String.raw`
set -u
workspace=$1
count=0
total=0
printf '@platform\tlinux\t'
compgen -c | LC_ALL=C sort -u | base64 | tr -d '\n'
printf '\n'
scan_root() {
  root=$1
  source=$2
  [ -d "$root" ] || return 0
  while IFS= read -r -d '' file; do
    size=$(stat -c %s -- "$file" 2>/dev/null) || continue
    [ "$size" -le ${MAX_SKILL_BYTES} ] || continue
    if [ "$count" -ge ${MAX_SKILLS} ] || [ $((total + size)) -gt ${MAX_CATALOG_BYTES} ]; then
      printf 'VM skill catalog limit exceeded\n' >&2
      exit 75
    fi
    printf '%s\t' "$source"
    printf '%s' "$file" | base64 | tr -d '\n'
    printf '\t'
    base64 < "$file" | tr -d '\n'
    printf '\n'
    count=$((count + 1))
    total=$((total + size))
  done < <(find -P "$root" -mindepth 2 -maxdepth 5 -type f -name SKILL.md -print0 2>/dev/null | sort -z)
}
scan_root "$workspace/skills" "platformclaw-vm-workspace"
scan_root "$workspace/.agents/skills" "platformclaw-vm-workspace"
scan_root "/opt/platformclaw/skills" "platformclaw-vm-managed"
scan_root "/opt/platformclaw/bundle" "platformclaw-vm-bundled"
`;

function decodeBase64(value: string, label: string, allowEmpty = false): Buffer {
  if (allowEmpty && value === "") {
    return Buffer.alloc(0);
  }
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error(`VM skill ${label} is invalid`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`VM skill ${label} is invalid`);
  }
  return decoded;
}

function parseCatalog(
  stdout: Buffer,
  target: AssignedVmTargetSnapshot,
): SandboxBackendSkillCatalog {
  if (stdout.length > MAX_SCAN_OUTPUT_BYTES) {
    throw new Error("VM skill catalog response exceeded the limit");
  }
  const files: SandboxBackendSkillFile[] = [];
  const [header, ...skillLines] = stdout.toString("utf8").split("\n");
  const headerParts = header?.split("\t") ?? [];
  if (headerParts.length !== 3 || headerParts[0] !== "@platform") {
    throw new Error("VM skill catalog platform response is invalid");
  }
  const bins = decodeBase64(headerParts[2] ?? "", "bins", true)
    .toString("utf8")
    .split("\n")
    .map((bin) => bin.trim())
    .filter(Boolean);
  let totalBytes = 0;
  for (const line of skillLines) {
    if (!line) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length !== 3) {
      throw new Error("VM skill catalog response is invalid");
    }
    const [source, encodedPath, encodedContent] = parts;
    if (!source || !SKILL_SOURCES.has(source)) {
      throw new Error("VM skill source is invalid");
    }
    if (files.length >= MAX_SKILLS) {
      throw new Error("VM skill catalog contained too many skills");
    }
    const filePathBytes = decodeBase64(encodedPath ?? "", "path");
    const contentBytes = decodeBase64(encodedContent ?? "", "content", true);
    if (filePathBytes.length > 4096 || contentBytes.length > MAX_SKILL_BYTES) {
      throw new Error("VM skill catalog entry exceeded the limit");
    }
    totalBytes += contentBytes.length;
    if (totalBytes > MAX_CATALOG_BYTES) {
      throw new Error("VM skill catalog content exceeded the limit");
    }
    const filePath = filePathBytes.toString("utf8");
    const content = contentBytes.toString("utf8");
    if (!filePath.startsWith("/") || !filePath.endsWith("/SKILL.md")) {
      throw new Error("VM skill path is invalid");
    }
    files.push({
      source,
      filePath,
      content,
      locationNote: `Stored on My development VM. Read this exact SKILL.md normally, and run referenced files on the current VM using absolute paths under ${filePath.slice(0, -"/SKILL.md".length)}.`,
    });
  }
  return Object.freeze({
    revision: `${target.targetId}:${target.revision}`,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    eligibility: Object.freeze({
      bins: Object.freeze(bins),
      platforms: Object.freeze([headerParts[1] ?? "linux"]),
    }),
  });
}

export class VmRemoteSkillCatalogService {
  private readonly cache = new Map<string, SandboxBackendSkillCatalog>();
  private readonly inflight = new Map<string, Promise<SandboxBackendSkillCatalog>>();

  constructor(
    private readonly io: RemoteSkillIo,
    private readonly timing: RemoteSkillTimingOptions = {},
  ) {}

  private logTiming(params: {
    startedAt: number;
    outcome: "cache-hit" | "cache-miss" | "refresh" | "inflight";
    refresh: boolean;
    status: "ok" | "error";
    files?: number;
  }): void {
    const now = this.timing.now ?? Date.now;
    this.timing.logTiming?.(
      `event=platformclaw_vm_skill_catalog_timing status=${params.status} outcome=${params.outcome} refresh=${String(params.refresh)} durationMs=${String(Math.max(0, now() - params.startedAt))}${params.files === undefined ? "" : ` files=${String(params.files)}`}`,
    );
  }

  async list(
    target: Readonly<AssignedVmTargetSnapshot>,
    refresh: boolean,
  ): Promise<SandboxBackendSkillCatalog> {
    const now = this.timing.now ?? Date.now;
    const startedAt = now();
    const targetPrefix = `${target.agentId}\0${target.targetId}:`;
    const key = `${targetPrefix}${target.revision}`;
    const cached = this.cache.get(key);
    if (cached && !refresh) {
      this.logTiming({
        startedAt,
        outcome: "cache-hit",
        refresh,
        status: "ok",
        files: cached.files.length,
      });
      return cached;
    }
    const active = this.inflight.get(key);
    if (active) {
      try {
        const catalog = await active;
        this.logTiming({
          startedAt,
          outcome: "inflight",
          refresh,
          status: "ok",
          files: catalog.files.length,
        });
        return catalog;
      } catch (error) {
        this.logTiming({ startedAt, outcome: "inflight", refresh, status: "error" });
        throw error;
      }
    }
    const outcome = refresh ? "refresh" : "cache-miss";
    const scan = this.scan(target, key, targetPrefix);
    this.inflight.set(key, scan);
    try {
      const catalog = await scan;
      this.logTiming({
        startedAt,
        outcome,
        refresh,
        status: "ok",
        files: catalog.files.length,
      });
      return catalog;
    } catch (error) {
      this.logTiming({ startedAt, outcome, refresh, status: "error" });
      throw error;
    } finally {
      if (this.inflight.get(key) === scan) {
        this.inflight.delete(key);
      }
    }
  }

  private async scan(
    target: Readonly<AssignedVmTargetSnapshot>,
    key: string,
    targetPrefix: string,
  ): Promise<SandboxBackendSkillCatalog> {
    const session = await this.io.createSession(target);
    try {
      const result = await this.io.runCommand({
        session,
        maxBufferBytes: MAX_SCAN_OUTPUT_BYTES,
        signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
        remoteCommand: buildRemoteCommand([
          "/bin/bash",
          "-c",
          VM_REMOTE_SKILL_SCAN_SCRIPT,
          "platformclaw-skill-scan",
          target.remoteWorkspaceDir,
        ]),
      });
      if (result.code !== 0) {
        throw new Error(`VM skill scan failed (${result.code})`);
      }
      const catalog = parseCatalog(result.stdout, target);
      for (const cachedKey of this.cache.keys()) {
        if (cachedKey.startsWith(targetPrefix)) {
          this.cache.delete(cachedKey);
        }
      }
      this.cache.set(key, catalog);
      while (this.cache.size > MAX_CACHED_TARGETS) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.cache.delete(oldest);
      }
      return catalog;
    } finally {
      await this.io.disposeSession(session);
    }
  }
}
