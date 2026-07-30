import { readFileSync } from "node:fs";
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { KnoxChannelConfig, ResolvedKnoxAccount } from "./types.js";

const MAX_SECRET_BYTES = 16 * 1024;
const DEFAULT_WEBHOOK_PATH = "/api/v1/platformclaw/knox/inbound";
const DEFAULT_CONTROL_PLANE_URL =
  "http://control.platformclaw.local:19001/platformclaw/internal/knox/route";

function channelConfig(cfg: OpenClawConfig): KnoxChannelConfig {
  return (cfg.channels?.knox as KnoxChannelConfig | undefined) ?? {};
}

const { listAccountIds, resolveAccountConfig } = createAccountListHelpers<KnoxChannelConfig>(
  "knox",
  {
    fallbackAccountIdWhenEmpty: false,
    hasImplicitDefaultAccount: (cfg) => {
      const config = channelConfig(cfg);
      return Boolean(
        config.outboundUrl ||
        process.env.PLATFORMCLAW_KNOX_CDEP_URL ||
        config.webhookSecretFile ||
        process.env.PLATFORMCLAW_KNOX_WEBHOOK_SECRET_FILE,
      );
    },
  },
);

export { listAccountIds };

function readSecretFile(path: string | undefined, label: string): string {
  if (!path) {
    return "";
  }
  const raw = readFileSync(path);
  if (raw.byteLength > MAX_SECRET_BYTES) {
    throw new Error(`${label} exceeds ${MAX_SECRET_BYTES} bytes`);
  }
  const value = raw.toString("utf8").trim();
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 32 || bytes > 512) {
    throw new Error(`${label} must contain 32 to 512 bytes`);
  }
  return value;
}

function normalizeHttpUrl(raw: string, label: string): string {
  if (!raw) {
    return "";
  }
  const url = new URL(raw);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be a credential-free HTTP(S) URL`);
  }
  return url.toString();
}

export function resolveKnoxAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedKnoxAccount {
  const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const merged = resolveAccountConfig(cfg, id);
  const webhookSecretFile =
    normalizeOptionalString(merged.webhookSecretFile) ??
    normalizeOptionalString(process.env.PLATFORMCLAW_KNOX_WEBHOOK_SECRET_FILE);
  const serviceTokenFile =
    normalizeOptionalString(merged.serviceTokenFile) ??
    normalizeOptionalString(process.env.PLATFORMCLAW_KNOX_SERVICE_TOKEN_FILE);
  const webhookSecret =
    normalizeOptionalString(merged.webhookSecret) ??
    readSecretFile(webhookSecretFile, "Knox webhook secret file");
  const serviceToken =
    normalizeOptionalString(merged.serviceToken) ??
    readSecretFile(serviceTokenFile, "Knox service token file");
  const outboundUrl = normalizeHttpUrl(
    normalizeOptionalString(merged.outboundUrl) ??
      normalizeOptionalString(process.env.PLATFORMCLAW_KNOX_CDEP_URL) ??
      "",
    "Knox CDEP outbound URL",
  );
  const controlPlaneUrl = normalizeHttpUrl(
    normalizeOptionalString(merged.controlPlaneUrl) ??
      normalizeOptionalString(process.env.PLATFORMCLAW_KNOX_CONTROL_PLANE_URL) ??
      DEFAULT_CONTROL_PLANE_URL,
    "Knox control-plane URL",
  );
  const resolved: ResolvedKnoxAccount = {
    accountId: normalizeOptionalString(merged.accountId) ?? id,
    enabled: merged.enabled ?? true,
    configured: false,
    webhookPath: DEFAULT_WEBHOOK_PATH,
    webhookSecret,
    outboundUrl,
    serviceToken,
    controlPlaneUrl,
    progressDelayMs: merged.progressDelayMs ?? 4_000,
  };
  resolved.configured = Boolean(
    resolved.webhookSecret &&
    resolved.outboundUrl &&
    resolved.serviceToken &&
    resolved.controlPlaneUrl,
  );
  return resolved;
}
