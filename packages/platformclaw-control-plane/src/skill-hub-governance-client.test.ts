import { describe, expect, it, vi } from "vitest";
import { IflytekSkillHubGovernanceClient } from "./skill-hub-governance-client.js";

function response(data: unknown, cookies: string[] = []) {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(JSON.stringify({ code: 0, data }), { headers });
}

describe("IflytekSkillHubGovernanceClient", () => {
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
      if (url.pathname.endsWith("/api/v1/reviews/my-submissions")) {
        return response({
          items: [
            {
              id: 42,
              namespace: "engineering",
              skillSlug: "demo-skill",
              version: "1.2.3",
              status: "PENDING",
            },
          ],
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
        items: [
          {
            id: 42,
            namespace: "engineering",
            skillSlug: "demo-skill",
            version: "1.2.3",
            status: "APPROVED",
          },
        ],
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
});
