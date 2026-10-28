import { describe, expect, it, vi } from "vitest";
import { IflytekSkillHubGovernanceClient } from "./skill-hub-governance-client.js";

const publicationId = "13a838a5-3f6a-4470-922c-c21d792dfd4d";
const identity = { namespace: `pc-${publicationId}`, slug: "demo", publicationId };
const metadata = {
  id: 17,
  namespace: identity.namespace,
  slug: identity.slug,
  displayName: "demo",
  summary: "",
  visibility: "PRIVATE",
  status: "ACTIVE",
};

function clientFixture(reply: (url: URL, init?: RequestInit) => Response) {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("/auth/methods")) {
      return new Response('{"code":0}', { headers: { "Set-Cookie": "XSRF-TOKEN=csrf; Path=/" } });
    }
    if (url.pathname.endsWith("/auth/direct/login")) {
      return new Response('{"code":0}', { headers: { "Set-Cookie": "SESSION=fixture; Path=/" } });
    }
    const headers = new Headers(init?.headers);
    expect(headers.get("Cookie")).toContain("SESSION=fixture");
    expect(headers.get("X-XSRF-TOKEN")).toBe("csrf");
    expect(headers.get("Authorization")).toBeNull();
    return reply(url, init);
  });
  return {
    fetchImpl,
    client: new IflytekSkillHubGovernanceClient({
      baseUrl: "http://registry.example.test",
      username: "fixture-admin",
      password: "fixture-password",
      fetchImpl,
    }),
  };
}

describe("managed identity reservation before archive upload", () => {
  it("reserves only the exact origin over the existing session and CSRF transport", async () => {
    const { client, fetchImpl } = clientFixture((url, init) => {
      expect(url.pathname).toBe("/api/v1/admin/platformclaw/skills/identities");
      expect(init?.method).toBe("POST");
      if (typeof init?.body !== "string") {
        throw new Error("Identity reservation must send a JSON string");
      }
      expect(JSON.parse(init.body)).toEqual(identity);
      return Response.json({ code: 0, data: metadata });
    });
    const revalidateAuthority = vi.fn(async () => {
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
    await expect(
      client.reserveArtifactIdentity({ ...identity, revalidateAuthority }),
    ).resolves.toEqual(metadata);
    expect(revalidateAuthority).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("stops before reservation when employee authority changes during login", async () => {
    const { client, fetchImpl } = clientFixture(() => {
      throw new Error("Revoked authority must not reserve an identity");
    });
    await expect(
      client.reserveArtifactIdentity({
        ...identity,
        revalidateAuthority: async () => {
          throw new Error("Employee was disabled");
        },
      }),
    ).rejects.toThrow("Employee was disabled");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects a mismatched namespace origin before authentication", async () => {
    const { client, fetchImpl } = clientFixture(() => Response.json({ code: 0, data: metadata }));
    await expect(
      client.reserveArtifactIdentity({
        ...identity,
        namespace: "pc-another-origin",
        revalidateAuthority: async () => undefined,
      }),
    ).rejects.toThrow("Invalid managed publication identity");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps an unknown native outcome unavailable and rejects coordinate substitution", async () => {
    const { client } = clientFixture(() => new Response("private native details", { status: 404 }));
    await expect(
      client.reserveArtifactIdentity({ ...identity, revalidateAuthority: async () => undefined }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const { client: changed } = clientFixture(() =>
      Response.json({ code: 0, data: { ...metadata, slug: "other" } }),
    );
    await expect(
      changed.reserveArtifactIdentity({ ...identity, revalidateAuthority: async () => undefined }),
    ).rejects.toThrow("Invalid artifact metadata identity");
  });
});
