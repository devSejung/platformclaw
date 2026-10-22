import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveKnoxAccount } from "./accounts.js";
import { KnoxChannelConfigSchema } from "./config-schema.js";

beforeEach(() => {
  for (const name of [
    "PLATFORMCLAW_KNOX_WEBHOOK_SECRET_FILE",
    "PLATFORMCLAW_KNOX_SERVICE_TOKEN_FILE",
    "PLATFORMCLAW_KNOX_CDEP_URL",
    "PLATFORMCLAW_KNOX_CONTROL_PLANE_URL",
  ]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => vi.unstubAllEnvs());

describe("Knox personal Space feature configuration", () => {
  it("defaults off without affecting existing relay readiness", () => {
    expect(
      resolveKnoxAccount({
        channels: {
          knox: {
            webhookSecret: "w".repeat(32),
            serviceToken: "s".repeat(32),
            outboundUrl: "http://cdep.example/outbound/send",
          },
        },
      }),
    ).toMatchObject({ selfInSpaceEnabled: false, configured: true, enabled: true });
  });

  it("inherits channel opt-in while allowing an account to opt out", () => {
    const cfg = {
      channels: {
        knox: {
          selfInSpaceEnabled: true,
          accounts: {
            inherited: {},
            disabled: { selfInSpaceEnabled: false },
          },
        },
      },
    };
    expect(resolveKnoxAccount(cfg, "inherited").selfInSpaceEnabled).toBe(true);
    expect(resolveKnoxAccount(cfg, "disabled").selfInSpaceEnabled).toBe(false);
    expect(
      resolveKnoxAccount(
        { channels: { knox: { accounts: { enabled: { selfInSpaceEnabled: true } } } } },
        "enabled",
      ).selfInSpaceEnabled,
    ).toBe(true);
  });

  it("requires a boolean in the channel runtime schema", () => {
    const runtime = KnoxChannelConfigSchema.runtime;
    if (!runtime) {
      throw new Error("expected Knox runtime config schema");
    }
    expect(runtime.safeParse({ selfInSpaceEnabled: true }).success).toBe(true);
    expect(runtime.safeParse({ selfInSpaceEnabled: "true" }).success).toBe(false);
    expect(runtime.safeParse({ accounts: { work: { selfInSpaceEnabled: true } } }).success).toBe(
      true,
    );
    expect(runtime.safeParse({ accounts: { work: { selfInSpaceEnabled: "true" } } }).success).toBe(
      false,
    );
  });
});
