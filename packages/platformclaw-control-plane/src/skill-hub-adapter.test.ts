import { describe, expect, it, vi } from "vitest";
import { IflytekSkillHubAdapter } from "./skill-hub-adapter.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

describe("IflytekSkillHubAdapter", () => {
  it.each([
    ["Skill not found: demo-skill", 404],
    ["Skill not found: another-skill", 400],
    ["request denied by a proxy", 400],
  ])(
    "normalizes only the pinned native detail absence envelope: %s",
    async (message, statusCode) => {
      const adapter = new IflytekSkillHubAdapter({
        baseUrl: "http://registry.example.test",
        token: "test-token",
        maxArchiveBytes: 1024,
        fetchImpl: async (input, init) => {
          expect(requestUrl(input).pathname).toBe("/api/v1/skills/engineering/demo-skill");
          expect(new Headers(init?.headers).get("Accept-Language")).toBe("en");
          return json({ code: 400, msg: message, data: null }, 400);
        },
      });
      await expect(adapter.getSkill("engineering", "demo-skill")).rejects.toMatchObject({
        statusCode,
      });
    },
  );

  it("distinguishes a terminal task failure from a completed security scan", async () => {
    const adapter = new IflytekSkillHubAdapter({
      baseUrl: "http://registry.example.test",
      token: "test-token",
      maxArchiveBytes: 1024,
      fetchImpl: async (input) => {
        expect(requestUrl(input).pathname).toBe("/api/v1/skills/1/versions/2/security-audit");
        return json({
          code: 0,
          data: [
            {
              scannerType: "SKILL_SCANNER",
              verdict: "SUSPICIOUS",
              isSafe: false,
              scannedAt: null,
              failedAt: "2026-10-16T00:00:00Z",
            },
          ],
        });
      },
    });
    await expect(adapter.listSecurityAudits(1, 2)).resolves.toEqual([
      {
        scannerType: "SKILL_SCANNER",
        verdict: "SUSPICIOUS",
        isSafe: false,
        failedAt: "2026-10-16T00:00:00Z",
        findings: [],
      },
    ]);
  });

  it("reads the exact version state without relying on a bounded version page", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(requestUrl(input).pathname).toBe(
        "/api/v1/skills/engineering/demo-skill/versions/1.0.0",
      );
      return json({ code: 0, data: { id: 2, version: "1.0.0", status: "PENDING_REVIEW" } });
    });
    const adapter = new IflytekSkillHubAdapter({
      baseUrl: "http://registry.example.test",
      token: "test-token",
      maxArchiveBytes: 1024,
      fetchImpl,
    });
    await expect(adapter.getVersionState("engineering", "demo-skill", "1.0.0")).resolves.toEqual({
      id: 2,
      version: "1.0.0",
      status: "PENDING_REVIEW",
    });
  });

  it("rejects an exact version response with a different version", async () => {
    const adapter = new IflytekSkillHubAdapter({
      baseUrl: "http://registry.example.test",
      token: "test-token",
      maxArchiveBytes: 1024,
      fetchImpl: async () => json({ code: 0, data: { version: "2.0.0", status: "PUBLISHED" } }),
    });
    await expect(adapter.getVersionState("engineering", "demo-skill", "1.0.0")).rejects.toThrow(
      "mismatched version detail",
    );
  });

  it("uses the pinned v0.2.16 CLI and portal API contracts", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/api/cli/v1/skills/search")) {
        return json({
          code: 0,
          data: {
            items: [
              {
                namespace: "engineering",
                slug: "demo-skill",
                latestVersion: "1.2.3",
                summary: "Demo",
              },
            ],
            total: 1,
            limit: 20,
          },
        });
      }
      if (url.pathname.endsWith("/versions")) {
        return json({
          code: 0,
          data: {
            items: [
              {
                id: 20,
                version: "1.2.3",
                status: "PUBLISHED",
                fileCount: 2,
                totalSize: 100,
                downloadAvailable: true,
              },
            ],
            total: 1,
            page: 0,
            size: 100,
          },
        });
      }
      return json({
        code: 0,
        data: {
          id: 10,
          namespace: "engineering",
          slug: "demo-skill",
          displayName: "Demo Skill",
          summary: "Demo",
          visibility: "PUBLIC",
          status: "PUBLISHED",
          ownerId: "must-not-reach-browser",
        },
      });
    });
    const adapter = new IflytekSkillHubAdapter({
      baseUrl: "https://skillhub.example.test/root/",
      token: "server-secret-token",
      maxArchiveBytes: 1024,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.search("demo", 20)).resolves.toMatchObject({ total: 1 });
    await expect(adapter.getSkill("engineering", "demo-skill")).resolves.not.toHaveProperty(
      "ownerId",
    );
    await expect(adapter.listVersions("engineering", "demo-skill")).resolves.toEqual([
      expect.objectContaining({ version: "1.2.3", downloadAvailable: true }),
    ]);

    expect(fetchImpl.mock.calls.map(([input]) => requestUrl(input).pathname)).toEqual([
      "/root/api/cli/v1/skills/search",
      "/root/api/v1/skills/engineering/demo-skill",
      "/root/api/v1/skills/engineering/demo-skill",
      "/root/api/v1/skills/engineering/demo-skill/versions",
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer server-secret-token");
    }
  });

  it("downloads from a presigned redirect without forwarding registry authorization", async () => {
    const archive = Buffer.from("zip");
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.hostname === "skillhub.example.test") {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer server-secret-token");
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: { Location: "https://objects.example.test/presigned" },
        });
      }
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return new Response(archive);
    });
    const adapter = new IflytekSkillHubAdapter({
      baseUrl: "https://skillhub.example.test",
      token: "server-secret-token",
      maxArchiveBytes: 1024,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.download("engineering", "demo-skill", "1.0.0")).resolves.toEqual(archive);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the pinned remote-delete contract and preserves an unresolved ok=false result", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer server-secret-token");
      return json({
        code: 0,
        data: {
          ok: false,
          scope: "remote",
          action: "delete",
          namespace: "engineering",
          slug: "demo-skill",
        },
      });
    });
    const adapter = new IflytekSkillHubAdapter({
      baseUrl: "https://skillhub.example.test/root/",
      token: "server-secret-token",
      maxArchiveBytes: 1024,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.deleteSkill("engineering", "demo-skill")).resolves.toEqual({
      ok: false,
      namespace: "engineering",
      slug: "demo-skill",
    });
    expect(requestUrl(fetchImpl.mock.calls[0]![0]).pathname).toBe(
      "/root/api/cli/v1/skills/engineering/demo-skill",
    );
  });

  it("rejects a delete response that drifts from the pinned remote hard-delete contract", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        code: 0,
        data: {
          ok: true,
          scope: "local",
          action: "delete",
          namespace: "engineering",
          slug: "demo-skill",
        },
      }),
    );
    const adapter = new IflytekSkillHubAdapter({
      baseUrl: "https://skillhub.example.test/root/",
      token: "server-secret-token",
      maxArchiveBytes: 1024,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.deleteSkill("engineering", "demo-skill")).rejects.toThrow(
      "invalid delete result",
    );
  });

  it("gives bounded archive transfers enough time for the 500 MiB contract", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => new AbortController().signal);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/download")) {
        return new Response(Buffer.from("zip"));
      }
      return json({
        code: 0,
        data: {
          namespace: "engineering",
          slug: "demo-skill",
          version: "1.0.0",
          visibility: "PRIVATE",
        },
      });
    });
    const adapter = new IflytekSkillHubAdapter({
      baseUrl: "https://skillhub.example.test",
      token: "server-secret-token",
      maxArchiveBytes: 1024,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await adapter.download("engineering", "demo-skill", "1.0.0");

    expect(timeout).toHaveBeenCalledExactlyOnceWith(600_000);
  });
});
