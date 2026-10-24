import { afterEach, describe, expect, it, vi } from "vitest";

function firstIssueMessage(result: {
  success: boolean;
  error?: { issues: Array<{ message: string }> };
}): string {
  if (result.success) {
    throw new Error("expected parse failure");
  }
  return result.error?.issues[0]?.message ?? "";
}

describe("zod default locale", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("restores English config diagnostics after the locale handler is cleared", async () => {
    vi.resetModules();
    const { z } = await import("zod");
    const previousLocaleError = z.config().localeError;
    const probe = z.object({ expected: z.string() }).strict();

    try {
      // Zod restores a missing default locale during schema construction. Use
      // an existing schema to exercise the missing-handler parse fallback.
      z.config({ localeError: undefined });
      expect(z.config().localeError).toBeUndefined();
      const degraded = probe.safeParse({ unexpected: true });
      expect(firstIssueMessage(degraded)).toBe("Invalid input");

      const { OpenClawSchema } = await import("./zod-schema.js");
      const restored = OpenClawSchema.safeParse({
        agents: { defaults: { session: { pruneAfter: "1d" } } },
      });
      expect(firstIssueMessage(restored)).toBe('Unrecognized key: "session"');
      const typeError = OpenClawSchema.safeParse({ gateway: { port: "not-a-number" } });
      expect(firstIssueMessage(typeError)).toBe("Invalid input: expected number, received string");
    } finally {
      z.config({ localeError: previousLocaleError });
    }
  });
});
