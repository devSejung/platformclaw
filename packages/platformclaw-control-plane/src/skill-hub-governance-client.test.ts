import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  IflytekSkillHubGovernanceClient,
  SkillHubGovernanceError,
} from "./skill-hub-governance-client.js";

function response(data: unknown, cookies: string[] = []) {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(JSON.stringify({ code: 0, data }), { headers });
}

const identity = { skillId: 10, versionId: 20, namespace: "pc-test", slug: "demo-skill" };
const namespace = { namespace: "pc-test", operationId: "fd4c04ae-339f-4eb4-8530-1e94b29db21a" };
const namespaceDto = {
  id: 1,
  slug: namespace.namespace,
  status: "ACTIVE",
  description: `PlatformClaw namespace operation:${namespace.operationId}`,
};
const audit = {
  id: 1,
  scannerType: "skill-scanner",
  verdict: "SAFE",
  isSafe: true,
  scannedAt: "2026-10-28T00:00:00Z",
  findings: [],
};
const security = { items: [audit], total: 1, artifactAvailable: true, blocked: false };

function managedClient(reply: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBeNull();
    if (url.pathname.endsWith("/auth/methods")) {
      return response({}, ["XSRF-TOKEN=csrf%2Btoken; Path=/"]);
    }
    if (url.pathname.endsWith("/auth/direct/login")) {
      expect(init?.method).toBe("POST");
      expect(headers.get("X-XSRF-TOKEN")).toBe("csrf+token");
      expect(typeof init?.body).toBe("string");
      expect(JSON.parse(jsonBody(init?.body))).toEqual({
        provider: "local",
        username: "admin",
        password: "test-only-password",
      });
      return response({}, ["SESSION=private-session; HttpOnly; Path=/"]);
    }
    expect(headers.get("Cookie")).toContain("SESSION=private-session");
    if (init?.method && init.method !== "GET") {
      expect(headers.get("X-XSRF-TOKEN")).toBe("csrf+token");
    }
    return await reply(url, init);
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

const servers: Server[] = [];
const tempDirs = createTempDirTracker();
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }),
  );
  tempDirs.cleanup();
});
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server unavailable");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("IflytekSkillHubGovernanceClient managed artifacts", () => {
  it("reads reserved metadata and all exact-ID versions through admin projections without portal access", async () => {
    const metadata = {
      id: 10,
      namespace: "pc-test",
      slug: "demo-skill",
      displayName: "",
      summary: "",
      visibility: "PRIVATE",
      status: "ACTIVE",
    };
    const { client } = managedClient((url) => {
      if (url.pathname.includes("/coordinates/")) {
        expect(url.pathname).toBe(
          "/api/v1/admin/platformclaw/skills/coordinates/pc-test/demo-skill",
        );
        expect(url.searchParams.get("expectedSkillId")).toBe("10");
        return response(metadata);
      }
      expect(url.pathname).toBe("/api/v1/admin/platformclaw/skills/10/artifact/versions");
      expect(url.searchParams.get("namespace")).toBe("pc-test");
      expect(url.searchParams.get("slug")).toBe("demo-skill");
      expect(url.searchParams.get("size")).toBe("100");
      return response({
        total: 101,
        items: Array.from(
          { length: url.searchParams.get("page") === "0" ? 100 : 1 },
          (_, index) => ({
            id: url.searchParams.get("page") === "0" ? index + 1 : 101,
            version: `1.0.${url.searchParams.get("page") === "0" ? index : 100}`,
            status: "SCANNING",
          }),
        ),
      });
    });
    await expect(
      client.getArtifactSkill({ namespace: "pc-test", slug: "demo-skill", expectedSkillId: 10 }),
    ).resolves.toEqual(metadata);
    const versions = await client.listArtifactVersions(identity);
    expect(versions).toHaveLength(101);
    expect(new Set(versions.map((version) => version.id)).size).toBe(101);
    expect(versions.every((version) => !("downloadAvailable" in version))).toBe(true);
  });

  it("preserves unknown artifact absence and rejects an administrative identity mismatch", async () => {
    const { client } = managedClient(() => new Response("private details", { status: 404 }));
    await expect(client.getArtifactSkill(identity)).rejects.toMatchObject({ statusCode: 404 });
    const { client: changed } = managedClient(() =>
      response({
        id: 11,
        namespace: "pc-test",
        slug: "demo-skill",
        displayName: "Demo",
        summary: "",
        visibility: "PRIVATE",
        status: "ACTIVE",
      }),
    );
    await expect(changed.getArtifactSkill({ ...identity, expectedSkillId: 10 })).rejects.toThrow(
      "identity",
    );
  });
  it("revalidates employee authority after session login and before the publication effect", async () => {
    const { client, fetchImpl } = managedClient(() => {
      throw new Error("Publication must not reach the registry");
    });
    const revalidateAuthority = vi.fn(async () => {
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      throw new Error("Publication owner was revoked");
    });
    await expect(
      client.publishArtifact({
        namespace: "pc-test",
        expectedSkillId: 10,
        archive: Buffer.from("ZIP"),
        filename: "demo.zip",
        revalidateAuthority,
      }),
    ).rejects.toThrow("Publication owner was revoked");
    expect(revalidateAuthority).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["buffer", "file"] as const)(
    "publishes original %s ZIP bytes with admin session/CSRF and exact update identity",
    async (source) => {
      const bytes = Buffer.from([0x50, 0x4b, 0, 255, 13, 10, 0, 128]);
      const archivePath = path.join(tempDirs.make("skillhub-managed-publish-"), "archive.zip");
      await writeFile(archivePath, bytes);
      const deadline = vi.spyOn(AbortSignal, "timeout");
      try {
        const { client, fetchImpl } = managedClient(async (url, init) => {
          expect(url.pathname).toBe("/api/v1/admin/platformclaw/skills/publish");
          expect(url.search).toBe("");
          expect(init?.method).toBe("POST");
          expect(init?.body instanceof ReadableStream).toBe(source === "file");
          const request = new Request(url, init);
          expect(request.headers.get("Content-Type")).toContain("multipart/form-data; boundary=");
          const wire = Buffer.from(await request.arrayBuffer());
          if (source === "file") {
            expect(request.headers.get("Content-Length")).toBe(String(wire.byteLength));
          }
          const form = await new Response(wire, { headers: request.headers }).formData();
          expect(form.get("namespace")).toBe("pc-test");
          expect(form.get("expectedSkillId")).toBe("10");
          expect(form.get("visibility")).toBeNull();
          const file = form.get("file");
          if (!(file instanceof File)) {
            throw new Error("Expected original ZIP file");
          }
          expect(file.name).toBe("demo-skill-1.0.0.zip");
          expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
          return response({
            skillId: 10,
            namespace: "pc-test",
            slug: "demo-skill",
            version: "1.0.0",
          });
        });
        await expect(
          client.publishArtifact({
            revalidateAuthority: async () => undefined,
            namespace: "pc-test",
            expectedSkillId: 10,
            archive: source === "file" ? { path: archivePath, size: bytes.byteLength } : bytes,
            filename: "demo-skill-1.0.0.zip",
          }),
        ).resolves.toEqual({
          skillId: 10,
          namespace: "pc-test",
          slug: "demo-skill",
          version: "1.0.0",
        });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(deadline).toHaveBeenLastCalledWith(600_000);
      } finally {
        deadline.mockRestore();
      }
    },
  );

  it.each([
    { skillId: 0, namespace: "pc-test", slug: "demo-skill", version: "1.0.0" },
    { skillId: 11, namespace: "pc-test", slug: "demo-skill", version: "1.0.0" },
    { skillId: 10, namespace: "different", slug: "demo-skill", version: "1.0.0" },
    { skillId: 10, namespace: "pc-test", slug: "", version: "1.0.0" },
    { skillId: 10, namespace: "pc-test", slug: "demo-skill", version: null },
  ])("rejects a changed or incomplete native publication identity: %j", async (data) => {
    const { client } = managedClient(() => response(data));
    await expect(
      client.publishArtifact({
        revalidateAuthority: async () => undefined,
        namespace: "pc-test",
        expectedSkillId: 10,
        archive: Buffer.from("ZIP"),
        filename: "demo.zip",
      }),
    ).rejects.toThrow("Invalid managed publication identity");
  });

  it("rejects oversized archive metadata and multipart header injection before authentication", async () => {
    const { client, fetchImpl } = managedClient(() => response({}));
    for (const params of [
      { archive: { path: "must-not-open", size: 500 * 1024 * 1024 + 1 }, filename: "demo.zip" },
      { archive: Buffer.from("ZIP"), filename: 'demo.zip"\r\nInjected: true' },
    ]) {
      await expect(
        client.publishArtifact({
          revalidateAuthority: async () => undefined,
          namespace: "pc-test",
          expectedSkillId: 10,
          ...params,
        }),
      ).rejects.toThrow("Invalid managed publication request");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([-1, 1])("stops a file-backed upload if its size changed by %s byte", async (delta) => {
    const bytes = Buffer.from("PK-fixed-synthetic-archive");
    const archivePath = path.join(tempDirs.make("skillhub-managed-size-"), "archive.zip");
    await writeFile(archivePath, bytes);
    const { client, fetchImpl } = managedClient(async (url, init) => {
      await new Request(url, init).arrayBuffer();
      throw new Error("Unexpected completed upload");
    });
    await expect(
      client.publishArtifact({
        revalidateAuthority: async () => undefined,
        namespace: "pc-test",
        expectedSkillId: 10,
        archive: { path: archivePath, size: bytes.byteLength + delta },
        filename: "demo.zip",
      }),
    ).rejects.toThrow("service is unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not fall back to retired native CLI publication or reflect its rejection body", async () => {
    const { client, fetchImpl } = managedClient(
      () => new Response("private-session test-only-password native warning", { status: 400 }),
    );
    await expect(
      client.publishArtifact({
        revalidateAuthority: async () => undefined,
        namespace: "pc-test",
        expectedSkillId: 10,
        archive: Buffer.from("ZIP"),
        filename: "demo.zip",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Skill Hub governance request failed (400)",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("reads all immutable audit history, preserving older malware evidence behind a later pending scan", async () => {
    const history = Array.from({ length: 100 }, (_, index) =>
      index === 0
        ? {
            ...audit,
            id: 1,
            verdict: "BLOCKED",
            isSafe: false,
            findings: [
              {
                ruleId: "VIRUSTOTAL_MALICIOUS_FILE",
                analyzer: "virustotal",
                category: "malware",
                metadata: { file_hash: "a".repeat(64) },
              },
            ],
          }
        : { ...audit, id: index + 1 },
    );
    const paths: string[] = [];
    const { client, fetchImpl } = managedClient((url, init) => {
      expect(init?.method).toBe("GET");
      expect(url.pathname).toBe("/api/v1/admin/platformclaw/skills/10/versions/20/security-audits");
      expect(url.searchParams.get("namespace")).toBe(identity.namespace);
      expect(url.searchParams.get("slug")).toBe(identity.slug);
      expect(url.searchParams.get("size")).toBe("100");
      paths.push(url.searchParams.get("page") ?? "");
      return response({
        ...security,
        total: 101,
        items:
          url.searchParams.get("page") === "0"
            ? history
            : [{ ...audit, id: 101, verdict: "PENDING", isSafe: false, scannedAt: undefined }],
        blocked: url.searchParams.get("page") === "0",
      });
    });
    const result = await client.getArtifactSecurity(identity);
    expect(paths).toEqual(["0", "1"]);
    expect(result.audits).toHaveLength(101);
    expect(result.audits[0]?.findings).toEqual([
      {
        ruleId: "VIRUSTOTAL_MALICIOUS_FILE",
        analyzer: "virustotal",
        category: "malware",
        fileHash: "a".repeat(64),
      },
    ]);
    expect(result.audits.at(-1)?.verdict).toBe("PENDING");
    expect(result).toMatchObject({ blocked: true, artifactAvailable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    { items: [], total: 0, artifactAvailable: true },
    { items: [], total: 0, blocked: false },
    { ...security, total: -1 },
    { ...security, total: 0 },
    { ...security, items: [{ ...audit, id: 0 }] },
    { ...security, items: [{ ...audit, id: "1" }] },
    { ...security, total: 2, items: [audit, audit] },
  ])("rejects an incomplete or inconsistent audit envelope: %j", async (data) => {
    const { client } = managedClient(() => response(data));
    await expect(client.getArtifactSecurity(identity)).rejects.toBeInstanceOf(
      SkillHubGovernanceError,
    );
  });

  it.each(["duplicate", "empty", "changed-total"] as const)(
    "rejects a %s later audit page",
    async (fault) => {
      const first = Array.from({ length: 100 }, (_, index) => ({ ...audit, id: index + 1 }));
      const { client } = managedClient((url) =>
        response({
          ...security,
          total: url.searchParams.get("page") === "1" && fault === "changed-total" ? 102 : 101,
          items:
            url.searchParams.get("page") === "0"
              ? first
              : fault === "empty"
                ? []
                : [
                    { ...audit, id: fault === "duplicate" ? 1 : 101 },
                    ...(fault === "changed-total" ? [{ ...audit, id: 102 }] : []),
                  ],
        }),
      );
      await expect(client.getArtifactSecurity(identity)).rejects.toBeInstanceOf(
        SkillHubGovernanceError,
      );
    },
  );

  it("downloads private ZIP bytes using the authenticated session and a ten-minute transfer deadline", async () => {
    const bytes = Buffer.from("PK-task-artifact");
    const deadline = vi.spyOn(AbortSignal, "timeout");
    try {
      const { client } = managedClient((url, init) => {
        expect(url.pathname).toBe("/api/v1/admin/platformclaw/skills/10/versions/20/artifact");
        expect(url.searchParams.get("namespace")).toBe(identity.namespace);
        expect(url.searchParams.get("slug")).toBe(identity.slug);
        expect(new Headers(init?.headers).get("Accept")).toBe("application/zip");
        return new Response(bytes, { headers: { "Content-Type": "application/zip" } });
      });
      await expect(client.downloadArtifact(identity)).resolves.toEqual(bytes);
      expect(deadline).toHaveBeenCalledWith(10 * 60_000);
    } finally {
      deadline.mockRestore();
    }
  });

  it("never follows an archive redirect or sends its governance cookie to the redirect target", async () => {
    const leakedCookies: Array<string | undefined> = [];
    const target = await listen(
      createServer((req, res) => {
        leakedCookies.push(req.headers.cookie);
        res.end("unexpected request");
      }),
    );
    const registry = await listen(
      createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/v1/auth/methods") {
          res.setHeader("Set-Cookie", "XSRF-TOKEN=csrf; Path=/");
          res.end(JSON.stringify({ code: 0, data: {} }));
        } else if (req.url === "/api/v1/auth/direct/login") {
          req.resume();
          res.setHeader("Set-Cookie", "SESSION=private-session; Path=/; HttpOnly");
          res.end(JSON.stringify({ code: 0, data: {} }));
        } else {
          res.writeHead(302, { Location: `${target}/stolen` });
          res.end();
        }
      }),
    );
    const client = new IflytekSkillHubGovernanceClient({
      baseUrl: registry,
      username: "admin",
      password: "test-only-password",
    });
    await expect(client.downloadArtifact(identity)).rejects.toThrow("service is unavailable");
    expect(leakedCookies).toEqual([]);
  });

  it.each(["declared", "streamed"] as const)(
    "bounds %s artifact bodies at 500 MiB and cancels the response",
    async (kind) => {
      const cancel = vi.fn();
      const chunk = new Uint8Array(1024 * 1024);
      const { client } = managedClient(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(chunk);
              },
              cancel,
            }),
            {
              headers:
                kind === "declared" ? { "Content-Length": String(500 * 1024 * 1024 + 1) } : {},
            },
          ),
      );
      await expect(client.downloadArtifact(identity)).rejects.toThrow("oversized");
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("deletes one native identity with CSRF and polls durable completion instead of treating absence as proof", async () => {
    const { client, fetchImpl } = managedClient((url, init) => {
      if (init?.method === "DELETE") {
        expect(url.pathname).toBe("/api/v1/admin/platformclaw/skills/10/artifact");
        expect(url.searchParams.get("namespace")).toBe(identity.namespace);
        expect(url.searchParams.get("slug")).toBe(identity.slug);
        return response({ skillId: 10, state: "pending" });
      }
      expect(url.pathname).toBe("/api/v1/admin/platformclaw/skills/10/artifact-deletion");
      return response({ skillId: 10, state: "completed", completedAt: "2026-10-28T01:00:00Z" });
    });
    await expect(client.deleteArtifact(identity)).resolves.toEqual({
      skillId: 10,
      state: "pending",
    });
    await expect(client.getArtifactDeletion(10)).resolves.toEqual({
      skillId: 10,
      state: "completed",
      completedAt: "2026-10-28T01:00:00Z",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    { skillId: 11, state: "pending" },
    { skillId: 10, state: "completed" },
    { skillId: 10, state: "completed", completedAt: "not a date" },
    { skillId: 10, state: "deleted" },
  ])("rejects invalid deletion receipts in both mutation and status reads: %j", async (receipt) => {
    const { client } = managedClient(() => response(receipt));
    await expect(client.deleteArtifact(identity)).rejects.toThrow(
      "Invalid artifact deletion receipt",
    );
    await expect(client.getArtifactDeletion(10)).rejects.toThrow(
      "Invalid artifact deletion receipt",
    );
  });

  it("returns unknown only for HTTP 404 deletion status, preserving other failures and redacting their bodies", async () => {
    const { client } = managedClient(
      () =>
        new Response("private registry details: test-only-password private-session", {
          status: 404,
        }),
    );
    await expect(client.getArtifactDeletion(10)).resolves.toBeNull();
    for (const status of [401, 403, 409, 500]) {
      const { client: rejected } = managedClient(
        () =>
          new Response("private registry details: test-only-password private-session", { status }),
      );
      await expect(rejected.getArtifactDeletion(10)).rejects.toMatchObject({
        name: "SkillHubGovernanceError",
        statusCode: status,
        message: `Skill Hub governance request failed (${status})`,
      });
    }
  });

  it("rejects success-envelope business errors without reflecting server data", async () => {
    const { client } = managedClient(
      () => new Response(JSON.stringify({ code: 409, msg: "secret registry data", data: {} })),
    );
    await expect(client.getArtifactDeletion(10)).rejects.toThrow(
      "Skill Hub rejected the governance request",
    );
  });

  it.each(["declared", "streamed"] as const)("bounds %s JSON replies to 1 MiB", async (kind) => {
    const cancel = vi.fn();
    const { client } = managedClient(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            },
            cancel,
          }),
          {
            headers: kind === "declared" ? { "Content-Length": String(1024 * 1024 + 1) } : {},
          },
        ),
    );
    await expect(client.getArtifactSecurity(identity)).rejects.toThrow("oversized");
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("IflytekSkillHubGovernanceClient managed session and namespace creation", () => {
  it("creates a namespace only after absence and binds it to a persisted operation marker", async () => {
    const { client, fetchImpl } = managedClient((url, init) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ code: 400, msg: "Namespace not found: pc-test" }), {
          status: 400,
        });
      }
      expect(url.pathname).toBe("/api/v1/namespaces");
      expect(JSON.parse(jsonBody(init?.body))).toEqual({
        slug: namespace.namespace,
        displayName: namespace.namespace,
        description: namespaceDto.description,
      });
      return response(namespaceDto);
    });
    await expect(client.createNamespace(namespace)).resolves.toEqual({
      id: 1,
      namespace: namespace.namespace,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("replays its own existing namespace without a duplicate mutation", async () => {
    const { client, fetchImpl } = managedClient(() => response(namespaceDto));
    await expect(client.createNamespace(namespace)).resolves.toEqual({
      id: 1,
      namespace: namespace.namespace,
    });
    await expect(client.createNamespace(namespace)).resolves.toEqual({
      id: 1,
      namespace: namespace.namespace,
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("recovers an exact concurrent namespace create after the native duplicate response", async () => {
    let reads = 0;
    const { client } = managedClient((_url, init) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ code: 400, msg: "Namespace slug 'pc-test' already exists" }),
          { status: 400 },
        );
      }
      return ++reads === 1
        ? new Response(JSON.stringify({ code: 400, msg: "Namespace not found: pc-test" }), {
            status: 400,
          })
        : response(namespaceDto);
    });
    await expect(client.createNamespace(namespace)).resolves.toEqual({
      id: 1,
      namespace: namespace.namespace,
    });
    expect(reads).toBe(2);
  });

  it.each([
    { ...namespaceDto, description: "unrelated operation" },
    { ...namespaceDto, status: "ARCHIVED" },
    { ...namespaceDto, slug: "different" },
  ])("never adopts mismatched namespace metadata: %j", async (dto) => {
    const { client } = managedClient(() => response(dto));
    await expect(client.createNamespace(namespace)).rejects.toBeInstanceOf(SkillHubGovernanceError);
  });

  it("re-authenticates after a session denial and coalesces concurrent login", async () => {
    let denied = true;
    const { client, fetchImpl } = managedClient(() => {
      if (denied) {
        denied = false;
        return new Response("private denial", { status: 403 });
      }
      return response(security);
    });
    await expect(client.getArtifactSecurity(identity)).rejects.toMatchObject({ statusCode: 403 });
    await Promise.all([client.getArtifactSecurity(identity), client.getArtifactSecurity(identity)]);
    expect(
      fetchImpl.mock.calls.filter(([input]) =>
        (typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).endsWith("/auth/direct/login"),
      ),
    ).toHaveLength(2);
  });

  it("requires a real session cookie after successful login", async () => {
    const fetchImpl = vi.fn(async () => response({}));
    const client = new IflytekSkillHubGovernanceClient({
      baseUrl: "https://registry.example.test",
      username: "admin",
      password: "test-only-password",
      fetchImpl,
    });
    await expect(client.getArtifactDeletion(10)).rejects.toThrow(
      "did not establish a governance session",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("redacts transport errors and keeps passwords out of serialized client state", async () => {
    const { client } = managedClient(() => {
      throw new Error("test-only-password private-session secret URL");
    });
    await expect(client.getArtifactDeletion(10)).rejects.toThrow(
      "Skill Hub governance service is unavailable",
    );
    expect(JSON.stringify(client)).not.toContain("test-only-password");
  });
});

function jsonBody(body: RequestInit["body"]): string {
  if (typeof body !== "string") {
    throw new Error("Expected JSON body");
  }
  return body;
}
