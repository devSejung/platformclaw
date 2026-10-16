import { describe, expect, it, vi } from "vitest";
import {
  IflytekSkillHubGovernanceClient,
  SkillHubGovernanceError,
  type SkillHubRegistryEdit,
} from "./skill-hub-governance-client.js";

function response(data: unknown, cookies: string[] = []) {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(JSON.stringify({ code: 0, data }), { headers });
}

describe("IflytekSkillHubGovernanceClient", () => {
  const edit: SkillHubRegistryEdit = {
    operationId: "fd4c04ae-339f-4eb4-8530-1e94b29db21a",
    skillId: 10,
    namespace: "engineering",
    slug: "demo-skill",
    targetNamespace: "shared",
    expectedRevision: "2026-10-16T00:00:00Z",
    displayName: "Edited demo",
    summary: "",
    visibility: "PRIVATE",
  };
  const metadata = {
    id: 10,
    namespace: "shared",
    slug: "demo-skill",
    revision: "2026-10-16T00:00:01Z",
    displayName: "Edited demo",
    summary: "",
    visibility: "PRIVATE",
    effectiveVisibility: "PRIVATE",
    reviewVersions: [],
  };

  function editingClient(reply: () => Response) {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/auth/methods")) {
        return response({}, ["XSRF-TOKEN=csrf; Path=/"]);
      }
      if (url.pathname.endsWith("/auth/direct/login")) {
        return response({}, ["SESSION=private-session; HttpOnly; Path=/"]);
      }
      expect(new Headers(init?.headers).get("Cookie")).toContain("SESSION=private-session");
      expect(new Headers(init?.headers).get("Authorization")).toBeNull();
      if (init?.method === "PATCH") {
        expect(url.pathname).toBe("/api/v1/admin/platformclaw/skills/10");
        expect(new Headers(init.headers).get("X-XSRF-TOKEN")).toBe("csrf");
        if (typeof init.body !== "string") {
          throw new Error("expected JSON edit body");
        }
        expect(JSON.parse(init.body)).toEqual(edit);
      }
      return reply();
    });
    return {
      fetchImpl,
      client: new IflytekSkillHubGovernanceClient({
        baseUrl: "http://registry.example.test",
        username: "admin",
        password: "test-only-password",
        fetchImpl,
      }),
    };
  }

  it("reads revisioned metadata and edits through a private CSRF session", async () => {
    const { client, fetchImpl } = editingClient(() => response(metadata));
    await expect(client.getEditableSkill("shared", "demo-skill")).resolves.toEqual(metadata);
    await expect(client.editSkill(edit)).resolves.toEqual(metadata);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    { ...metadata, id: 11 },
    { ...metadata, namespace: "engineering" },
    { ...metadata, slug: "different-skill" },
    { ...metadata, visibility: "PUBLIC" },
    { ...metadata, summary: "unexpected text" },
  ])("rejects an edit result for a different mutation: %j", async (result) => {
    const { client } = editingClient(() => response(result));
    await expect(client.editSkill(edit)).rejects.toThrow("mismatched edit result");
  });

  it("preserves definitive revision conflict status without reflecting the server body", async () => {
    const { client } = editingClient(
      () => new Response("internal registry details", { status: 409 }),
    );
    await expect(client.editSkill(edit)).rejects.toMatchObject({
      name: "SkillHubGovernanceError",
      statusCode: 409,
    });
  });

  it("rejects a business error in an HTTP success envelope", async () => {
    const { client } = editingClient(
      () => new Response(JSON.stringify({ code: 409, data: metadata })),
    );
    await expect(client.editSkill(edit)).rejects.toBeInstanceOf(SkillHubGovernanceError);
  });

  it("bounds streamed replies even without Content-Length", async () => {
    const cancel = vi.fn();
    const { client } = editingClient(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            },
            cancel,
          }),
        ),
    );
    await expect(client.editSkill(edit)).rejects.toThrow("oversized");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a review resolved for a different version before approval", async () => {
    const { client, fetchImpl } = editingClient(() =>
      response({
        id: 42,
        namespace: "engineering",
        skillSlug: "demo-skill",
        version: "2.0.0",
        status: "PENDING",
      }),
    );
    await expect(
      client.approvePendingReview({
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.2.3",
        comment: "policy",
      }),
    ).rejects.toThrow("mismatched exact version review");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("uses a server-only CSRF session and approves one exact pending review", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/api/v1/auth/methods")) {
        return response({}, ["XSRF-TOKEN=csrf-token; Path=/"]);
      }
      if (url.pathname.endsWith("/api/v1/auth/direct/login")) {
        const body = init?.body;
        if (typeof body !== "string") {
          throw new Error("expected JSON login body");
        }
        expect(JSON.parse(body)).toMatchObject({
          provider: "local",
          username: "bootstrap-admin",
          password: "governance-secret",
        });
        expect(new Headers(init?.headers).get("X-XSRF-TOKEN")).toBe("csrf-token");
        return response({}, ["SESSION=session-value; HttpOnly; Path=/"]);
      }
      expect(new Headers(init?.headers).get("Cookie")).toContain("SESSION=session-value");
      if (
        url.pathname.endsWith(
          "/api/v1/admin/platformclaw/skills/engineering/demo-skill/versions/1.2.3/review",
        )
      ) {
        return response({
          id: 42,
          namespace: "engineering",
          skillSlug: "demo-skill",
          version: "1.2.3",
          status: "PENDING",
        });
      }
      if (url.pathname.endsWith("/api/v1/reviews/42/approve")) {
        return response({ id: 42, status: "APPROVED" });
      }
      throw new Error(`unexpected governance path: ${url.pathname}`);
    });
    const client = new IflytekSkillHubGovernanceClient({
      baseUrl: "https://skillhub.example.test/internal/",
      username: "bootstrap-admin",
      password: "governance-secret",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.approvePendingReview({
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.2.3",
        comment: "approved by policy",
      }),
    ).resolves.toEqual({ reviewId: 42, status: "APPROVED" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("treats an exact already-approved review as an idempotent success", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/api/v1/auth/methods")) {
        return response({}, ["XSRF-TOKEN=csrf-token; Path=/"]);
      }
      if (url.pathname.endsWith("/api/v1/auth/direct/login")) {
        return response({}, ["SESSION=session-value; HttpOnly; Path=/"]);
      }
      return response({
        id: 42,
        namespace: "engineering",
        skillSlug: "demo-skill",
        version: "1.2.3",
        status: "APPROVED",
      });
    });
    const client = new IflytekSkillHubGovernanceClient({
      baseUrl: "https://skillhub.example.test",
      username: "bootstrap-admin",
      password: "governance-secret",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.approvePendingReview({
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.2.3",
        comment: "approved by policy",
      }),
    ).resolves.toEqual({ reviewId: 42, status: "APPROVED" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each(["PENDING", "APPROVED"])(
    "revalidates SAFE scans atomically even for a previously %s review",
    async (status) => {
      const paths: string[] = [];
      const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        paths.push(url.pathname);
        if (url.pathname.endsWith("/auth/methods")) {
          return response({}, ["XSRF-TOKEN=csrf-token; Path=/"]);
        }
        if (url.pathname.endsWith("/auth/direct/login")) {
          return response({}, ["SESSION=private-session; HttpOnly; Path=/"]);
        }
        if (url.pathname.endsWith("/review")) {
          return response({
            id: 42,
            namespace: "engineering",
            skillSlug: "demo-skill",
            version: "1.2.3",
            status,
          });
        }
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("X-XSRF-TOKEN")).toBe("csrf-token");
        expect(url.pathname).toBe(
          "/api/v1/admin/platformclaw/skills/engineering/demo-skill/versions/1.2.3/approve-safe",
        );
        return new Response("scan changed before approval", { status: 409 });
      });
      const client = new IflytekSkillHubGovernanceClient({
        baseUrl: "http://registry.example.test",
        username: "admin",
        password: "test-only-password",
        fetchImpl,
      });
      await expect(
        client.approvePendingReview({
          namespace: "engineering",
          slug: "demo-skill",
          version: "1.2.3",
          comment: "automatic policy",
          requireSafeScan: true,
        }),
      ).rejects.toMatchObject({ name: "SkillHubGovernanceError", statusCode: 409 });
      expect(paths).toHaveLength(4);
      expect(paths).not.toContain("/api/v1/reviews/42/approve");
    },
  );
});
