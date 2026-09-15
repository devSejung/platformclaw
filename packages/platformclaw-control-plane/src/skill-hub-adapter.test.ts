import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

  it("retries extension-only publish warnings through the confirmable portal contract", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("visibility")).toBe("PRIVATE");
      expect(form.get("file")).toBeInstanceOf(Blob);
      if (url.pathname.endsWith("/api/cli/v1/skills/engineering/publish")) {
        expect(url.searchParams.get("confirmWarnings")).toBeNull();
        return json(
          {
            code: 400,
            msg: [
              "Pre-publish warnings require confirmation before publishing:",
              "- Disallowed file extension: data/events.jsonl",
              "- Disallowed file extension: models/index.bin",
            ].join("\n"),
          },
          400,
        );
      }
      expect(url.pathname).toBe("/api/v1/skills/engineering/publish");
      expect(url.searchParams.get("confirmWarnings")).toBe("true");
      return json({
        code: 0,
        data: {
          skillId: 10,
          namespace: "engineering",
          slug: "demo-skill",
          version: "1.0.0",
          status: "PENDING_REVIEW",
          fileCount: 3,
          totalSize: 123,
        },
      });
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
    ).resolves.toEqual({
      namespace: "engineering",
      slug: "demo-skill",
      version: "1.0.0",
      visibility: "PRIVATE",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rebuilds file-backed publish streams when confirming extension-only warnings", async () => {
    const archivePath = fileURLToPath(import.meta.url);
    const contentTypes: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      const contentType = new Headers(init?.headers).get("Content-Type");
      expect(contentType).toContain("multipart/form-data; boundary=platformclaw-");
      contentTypes.push(contentType!);
      const body = init?.body;
      if (!(body instanceof ReadableStream)) {
        throw new Error("expected a streamed multipart body");
      }
      await new Response(body).arrayBuffer();
      if (url.pathname.endsWith("/api/cli/v1/skills/engineering/publish")) {
        return json(
          {
            code: 400,
            msg: [
              "Pre-publish warnings require confirmation before publishing:",
              "- Disallowed file extension: models/index.bin",
            ].join("\n"),
          },
          400,
        );
      }
      expect(url.pathname).toBe("/api/v1/skills/engineering/publish");
      expect(url.searchParams.get("confirmWarnings")).toBe("true");
      return json({
        code: 0,
        data: {
          namespace: "engineering",
          slug: "demo-skill",
          version: "1.0.0",
        },
      });
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
        archive: { path: archivePath, size: statSync(archivePath).size },
        filename: "demo.zip",
        visibility: "PRIVATE",
      }),
    ).resolves.toEqual({
      namespace: "engineering",
      slug: "demo-skill",
      version: "1.0.0",
      visibility: "PRIVATE",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(contentTypes[0]).not.toBe(contentTypes[1]);
  });

  it("does not auto-confirm extension warnings when another publish warning is present", async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        {
          code: 400,
          msg: [
            "Pre-publish warnings require confirmation before publishing:",
            "- Disallowed file extension: models/index.bin",
            "- SKILL.md line 5 contains a value that looks like a secret or token.",
          ].join("\n"),
        },
        400,
      ),
    );
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
    ).rejects.toThrow("looks like a secret or token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

    await adapter.publish({
      namespace: "engineering",
      archive: Buffer.from("zip"),
      filename: "demo.zip",
      visibility: "PRIVATE",
    });
    await adapter.download("engineering", "demo-skill", "1.0.0");

    expect(timeout).toHaveBeenNthCalledWith(1, 600_000);
    expect(timeout).toHaveBeenNthCalledWith(2, 600_000);
  });
});
