import { describe, expect, it, vi } from "vitest";
import { IflytekSkillHubAdapter } from "./skill-hub-adapter.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("IflytekSkillHubAdapter", () => {
  it("uses the pinned v0.2.16 CLI and portal API contracts", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
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
      return json({ code: 0, data: { namespace: "engineering", slug: "demo-skill" } });
    });
    const adapter = new IflytekSkillHubAdapter({
      baseUrl: "https://skillhub.example.test/root/",
      token: "server-secret-token",
      maxArchiveBytes: 1024,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.search("demo", 20)).resolves.toMatchObject({ total: 1 });
    await adapter.getSkill("engineering", "demo-skill");
    await expect(adapter.listVersions("engineering", "demo-skill")).resolves.toEqual([
      expect.objectContaining({ version: "1.2.3", downloadAvailable: true }),
    ]);

    expect(fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/root/api/cli/v1/skills/search",
      "/root/api/v1/skills/engineering/demo-skill",
      "/root/api/v1/skills/engineering/demo-skill/versions",
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer server-secret-token");
    }
  });

  it("publishes multipart data without exposing the bearer token in returned errors", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("visibility")).toBe("PRIVATE");
      expect(form.get("file")).toBeInstanceOf(Blob);
      return json({ message: "internal token server-secret-token failed" }, 500);
    });
    const adapter = new IflytekSkillHubAdapter({
      baseUrl: "https://skillhub.example.test",
      token: "server-secret-token",
      maxArchiveBytes: 1024,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      adapter.publish({
        namespace: "engineering",
        archive: Buffer.from("zip"),
        filename: "demo.zip",
        visibility: "PRIVATE",
      }),
    ).rejects.not.toThrow("server-secret-token");
  });
});
