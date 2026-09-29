import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import { BrowserGatewayProxy, type BrowserGatewayRpc } from "./browser-gateway-proxy.js";
import { handleKnowledgeVaultHttp } from "./browser-vault-http.js";
import type { KnowledgeVaultSnapshot } from "./knowledge-vault-contracts.js";
import { KnowledgeVaultService } from "./knowledge-vault-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vault-browser-")));
  const store = new SqliteControlPlaneStore({
    databasePath: join(root, "control.sqlite"),
    initialAdminAccountIds: ["employee"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { user } = await store.upsertPrincipal(
    { provider: "ldap", subject: "employee", accountId: "employee", employeeId: "employee" },
    Date.now(),
  );
  const reserved = await store.reservePersonalAgent(user.id, Date.now());
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: Date.now(),
  });
  const token = "vault-test-session";
  await store.createBrowserSession({
    userId: user.id,
    tokenHash: hashBrowserSessionToken(token),
    createdAt: Date.now(),
  });
  const auth = new BrowserAuthService({
    store,
    authenticator: {
      authenticatePassword: async () => ({ status: "rejected", message: "unused" }),
    },
    provisioner: { provisionOrRefresh: async () => {} },
  });
  const request = vi.fn<BrowserGatewayRpc["request"]>(async (method) =>
    method === "wiki.search"
      ? [
          {
            corpus: "wiki",
            path: "concepts/training.md",
            title: "Training",
            kind: "concept",
            snippet: "training wiki",
            score: 0.8,
            revision: "b".repeat(64),
          },
        ]
      : {
          agentId: binding.agentId,
          provider: "local",
          searchMode: "fts-only",
          results: [
            {
              path: "MEMORY.md",
              snippet: "training memory",
              source: "memory",
              score: 0.7,
              startLine: 1,
              endLine: 2,
              sourceVersion: "a".repeat(64),
            },
          ],
        },
  );
  const vaultService = new KnowledgeVaultService(store, { request });
  const proxy = new BrowserGatewayProxy({
    authService: auth,
    store,
    auditWriter: store,
    gateway: { request },
    vaultService,
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    resolveAgentIdFromSessionKey: (key) => key.split(":")[1] ?? null,
  });
  return {
    store,
    user,
    binding,
    token,
    request,
    proxy,
    vaultService,
    auth,
    databasePath: join(root, "control.sqlite"),
  };
}

describe("knowledge vault browser boundary", () => {
  it("bounds link targets to the editable selected Wiki and returns safe insertable markup", async () => {
    const { store, user, proxy, token } = await setup();
    const vault = store.vaults.createVault({ userId: user.id, name: "Picker" });
    for (let index = 0; index < 21; index++) {
      store.vaults.saveDocument({
        userId: user.id,
        vaultId: vault.id,
        title: `Document ${index}`,
        content: `Body ${index}`,
      });
    }
    const all = await proxy.request<{ items: unknown[]; hasMore: boolean }>(
      token,
      "platformclaw.vault.document.targets",
      { vaultId: vault.id, query: "" },
    );
    expect(all.items).toHaveLength(20);
    expect(all.hasMore).toBe(true);
    const target = store.vaults.saveDocument({
      userId: user.id,
      vaultId: vault.id,
      title: "Escaped target",
      logicalPath: "spec/a#b].md",
      content: "Safe",
    });
    const selected = await proxy.request<{ items: Array<{ documentId: string; link: string }> }>(
      token,
      "platformclaw.vault.document.targets",
      { vaultId: vault.id, query: "Escaped" },
    );
    expect(selected.items).toEqual([
      expect.objectContaining({
        documentId: target.id,
        link: "[[spec/a%23b%5D.md|Escaped target]]",
      }),
    ]);
    const source = store.vaults.saveDocument({
      userId: user.id,
      vaultId: vault.id,
      content: selected.items[0]!.link,
    });
    expect(source.links[0]!.documentId).toBe(target.id);
    await expect(
      proxy.request(token, "platformclaw.vault.document.targets", {
        vaultId: vault.id,
        query: "' OR 1=1 --",
      }),
    ).resolves.toEqual({ items: [], hasMore: false });
    await expect(
      proxy.request(token, "platformclaw.vault.document.targets", {
        vaultId: vault.id,
        query: "x".repeat(161),
      }),
    ).rejects.toThrow("160");
    const { user: other } = await store.upsertPrincipal(
      { provider: "ldap", subject: "other", accountId: "other", employeeId: "other" },
      Date.now(),
    );
    const privateVault = store.vaults.createVault({ userId: other.id, name: "No access" });
    await expect(
      proxy.request(token, "platformclaw.vault.document.targets", {
        vaultId: privateVault.id,
        query: "",
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    store.vaults.setMember({
      userId: other.id,
      vaultId: privateVault.id,
      memberUserId: user.id,
      role: "reader",
    });
    await expect(
      proxy.request(token, "platformclaw.vault.document.targets", {
        vaultId: privateVault.id,
        query: "",
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
  });
  it("previews bounded metadata without writing, allocates unique paths and retains edited metadata", async () => {
    const { store, user, proxy, token } = await setup();
    const vault = store.vaults.createVault({
      userId: user.id,
      name: "Shared",
    });
    const input = {
      vaultId: vault.id,
      filename: "training.markdown",
      content: "---\r\ntitle: Training guide\r\n---\r\n# Training\r\n",
    };
    expect(await proxy.request(token, "platformclaw.vault.document.preview", input)).toEqual({
      title: "Training guide",
      logicalPath: "training.md",
    });
    expect(
      store.vaults.snapshot({ userId: user.id, vaultId: vault.id }).selected?.documents,
    ).toHaveLength(0);
    // Two drafts may preview the same free path; the serialized writes must allocate separately.
    const save = () =>
      proxy.request<{ id: string; logicalPath: string; content: string; revision: number }>(
        token,
        "platformclaw.vault.document.save",
        input,
      );
    const [first, second] = await Promise.all([save(), save()]);
    expect([first.logicalPath, second.logicalPath].toSorted()).toEqual([
      "training-2.md",
      "training.md",
    ]);
    expect(first.content).toBe(input.content);
    expect(
      await proxy.request(token, "platformclaw.vault.document.save", {
        vaultId: vault.id,
        documentId: first.id,
        expectedRevision: first.revision,
        content: "# Changed heading",
      }),
    ).toMatchObject({ title: "Training guide", logicalPath: first.logicalPath });
    await expect(
      proxy.request(token, "platformclaw.vault.document.save", {
        ...input,
        logicalPath: first.logicalPath,
      }),
    ).rejects.toThrow("already exists");
    await expect(
      proxy.request(token, "platformclaw.vault.document.preview", {
        ...input,
        content: "가".repeat(400_000),
      }),
    ).rejects.toThrow("1 MiB");
    const { user: owner } = await store.upsertPrincipal(
      { provider: "ldap", subject: "other", accountId: "other", employeeId: "other" },
      Date.now(),
    );
    const readOnly = store.vaults.createVault({
      userId: owner.id,
      name: "Read only",
    });
    store.vaults.setMember({
      userId: owner.id,
      vaultId: readOnly.id,
      memberUserId: user.id,
      role: "reader",
    });
    await expect(
      proxy.request(token, "platformclaw.vault.document.preview", {
        ...input,
        vaultId: readOnly.id,
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
  });
  it("resolves only exact authorized names, including disconnected Vaults, and disambiguates duplicates", async () => {
    const { store, user, binding, vaultService } = await setup();
    const { user: owner } = await store.upsertPrincipal(
      {
        provider: "ldap",
        subject: "vault-owner",
        accountId: "vault-owner",
        employeeId: "vault-owner",
      },
      Date.now(),
    );
    const vault = store.vaults.createVault({
      userId: owner.id,
      name: "PHY Spec",
    });
    store.vaults.saveDocument({
      userId: owner.id,
      vaultId: vault.id,
      title: "Training",
      logicalPath: "training.md",
      content: "training voltage",
    });
    const search = (extra: { vaultName?: string; vaultId?: string } = {}) =>
      vaultService.search({
        agentId: binding.agentId,
        query: "training",
        turnScope: { revision: 0, vaultIds: [], personalEnabled: true },
        ...extra,
      });
    await expect(search({ vaultName: "PHY Spec" })).rejects.toMatchObject({
      code: "vault-name-not-found",
      vaultChoices: [],
    });
    store.vaults.setMember({
      userId: owner.id,
      vaultId: vault.id,
      memberUserId: user.id,
      role: "reader",
    });
    expect(await search()).toEqual([]);
    expect(await search({ vaultName: "PHY Spec" })).toEqual([
      expect.objectContaining({ vaultId: vault.id }),
    ]);
    expect(await search({ vaultName: "  phy spec  " })).toEqual([
      expect.objectContaining({ vaultId: vault.id }),
    ]);
    await expect(search({ vaultName: "PHY" })).rejects.toMatchObject({
      code: "vault-name-not-found",
    });
    await expect(search({ vaultName: "PHY Spec", vaultId: vault.id })).rejects.toThrow(
      "only vaultId",
    );
    for (let i = 0; i < 6; i++) {
      store.vaults.createVault({ userId: user.id, name: "PHY Spec" });
    }
    await expect(search({ vaultName: "PHY Spec" })).rejects.toMatchObject({
      code: "vault-name-ambiguous",
      vaultChoices: Array.from({ length: 5 }, () =>
        expect.objectContaining({ vaultName: "PHY Spec", vaultType: "shared" }),
      ),
    });
    expect(await search({ vaultId: vault.id })).toHaveLength(1);
    store.vaults.removeMember({ userId: owner.id, vaultId: vault.id, memberUserId: user.id });
    await expect(search({ vaultId: vault.id })).rejects.toThrow();
    try {
      await search({ vaultName: "PHY Spec" });
    } catch (error) {
      expect(
        (error as { vaultChoices: Array<{ vaultId: string }> }).vaultChoices.map(
          (choice) => choice.vaultId,
        ),
      ).not.toContain(vault.id);
    }
  });
  it("separates invitation, connection, run snapshot and live ACL at the browser boundary", async () => {
    const { store, user, binding, token, proxy, vaultService } = await setup();
    const { user: owner } = await store.upsertPrincipal(
      { provider: "ldap", subject: "owner", accountId: "owner", employeeId: "owner" },
      Date.now(),
    );
    const vault = store.vaults.createVault({
      userId: owner.id,
      name: "Invited",
    });
    store.vaults.setMember({
      userId: owner.id,
      vaultId: vault.id,
      memberUserId: user.id,
      role: "reader",
    });
    store.vaults.saveDocument({
      userId: owner.id,
      vaultId: vault.id,
      title: "Training",
      logicalPath: "spec.md",
      content: "training shared",
    });
    const snapshot = await proxy.request<KnowledgeVaultSnapshot>(
      token,
      "platformclaw.vault.snapshot",
      {},
    );
    expect(snapshot.vaults.find((entry) => entry.id === vault.id)).toMatchObject({
      connected: true,
      documentCount: 1,
      attachmentCount: 0,
      role: "reader",
      canEdit: false,
    });
    const search = async (scope?: "connected" | "all", vaultId?: string) =>
      (
        await proxy.request<{ results: Array<{ vaultId: string }> }>(token, "memory.search", {
          query: "training",
          ...(scope ? { scope } : {}),
          ...(vaultId ? { vaultId } : {}),
        })
      ).results.map((hit) => hit.vaultId);
    expect(await search()).toContain(vault.id);
    expect(await search("all")).toContain(vault.id);
    expect(await search(undefined, vault.id)).toEqual([vault.id]);
    const connected = await proxy.request<KnowledgeVaultSnapshot>(
      token,
      "platformclaw.vault.connection.set",
      { vaultId: vault.id, connected: true },
    );
    expect(connected.selectionRevision).toBe(1);
    expect(await search()).toContain(vault.id);
    const turnScope = vaultService.captureScope({ agentId: binding.agentId });
    const disconnected = await proxy.request<KnowledgeVaultSnapshot>(
      token,
      "platformclaw.vault.connection.set",
      { vaultId: vault.id, connected: false },
    );
    expect(disconnected.selectionRevision).toBe(2);
    expect(
      await vaultService.search({ agentId: binding.agentId, query: "training", turnScope }),
    ).toHaveLength(1);
    expect(
      await vaultService.search({
        agentId: binding.agentId,
        query: "training",
        turnScope: vaultService.captureScope({ agentId: binding.agentId }),
      }),
    ).toEqual([]);
    expect(await search()).not.toContain(vault.id);
    await expect(
      proxy.request(token, "platformclaw.vault.connection.set", {
        vaultId: vault.id,
        connected: true,
        userId: owner.id,
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "platformclaw.vault.connection.set", {
        vaultId: vault.id,
        connected: "yes",
      }),
    ).rejects.toMatchObject({ code: "invalid-params" });
    store.vaults.removeMember({ userId: owner.id, vaultId: vault.id, memberUserId: user.id });
    expect(
      await vaultService.search({ agentId: binding.agentId, query: "training", turnScope }),
    ).toEqual([]);
    await expect(search(undefined, vault.id)).rejects.toThrow();
    await expect(
      proxy.request(token, "platformclaw.vault.connection.set", {
        vaultId: vault.id,
        connected: true,
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
  });

  it("lists only the bound Personal Wiki and rejects foreign Personal ids", async () => {
    const { proxy, token, binding } = await setup();
    const snapshot = await proxy.request<KnowledgeVaultSnapshot>(
      token,
      "platformclaw.vault.snapshot",
      {},
    );
    expect(snapshot.vaults).toEqual([
      expect.objectContaining({
        id: `personal:${binding.agentId}`,
        type: "personal",
        role: "owner",
        connected: true,
      }),
    ]);
    await expect(
      proxy.request(token, "platformclaw.vault.connection.set", {
        vaultId: "personal:other",
        connected: false,
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
  });
  it("creates, writes and searches with server identity and complete provenance", async () => {
    const { proxy, token, store, user, request } = await setup();
    const vault = await proxy.request<{ id: string }>(token, "platformclaw.vault.create", {
      name: "Training",
    });
    await proxy.request(token, "platformclaw.vault.document.save", {
      vaultId: vault.id,
      title: "Training",
      logicalPath: "spec.md",
      content: "training shared",
    });
    const snapshot = await proxy.request<KnowledgeVaultSnapshot>(
      token,
      "platformclaw.vault.snapshot",
      { vaultId: vault.id },
    );
    expect(snapshot.selected?.graph).toEqual({
      edges: [],
      unresolvedLinks: 0,
      truncated: false,
    });
    expect(snapshot.selected?.documents).toEqual([
      expect.objectContaining({
        title: "Training",
        revision: 1,
        compile: expect.objectContaining({ status: "ready", indexedRevision: 1 }),
      }),
    ]);
    const results = await proxy.request<{ results: Array<Record<string, unknown>> }>(
      token,
      "memory.search",
      { query: "training" },
    );
    expect(results.results).toHaveLength(3);
    for (const hit of results.results) {
      for (const key of [
        "vaultId",
        "vaultName",
        "vaultType",
        "documentId",
        "title",
        "path",
        "snippet",
        "revision",
      ]) {
        expect(hit[key]).toBeDefined();
      }
    }
    request.mockClear();
    const scoped = await proxy.request<{ results: Array<{ vaultId: string }> }>(
      token,
      "memory.search",
      { query: "training", vaultId: vault.id },
    );
    expect(scoped.results.map((hit) => hit.vaultId)).toEqual([vault.id]);
    expect(request).not.toHaveBeenCalled();
    await expect(
      proxy.request(token, "platformclaw.vault.create", { userId: "other", name: "spoof" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(store.vaults.listVaults(user.id)).toHaveLength(1);
  });

  it("keeps authorized shared results visible when personal indexes fail", async () => {
    const { proxy, token, store, user, request } = await setup();
    const vault = store.vaults.createVault({
      userId: user.id,
      name: "Shared",
    });
    store.vaults.saveDocument({
      userId: user.id,
      vaultId: vault.id,
      title: "training",
      logicalPath: "spec.md",
      content: "training",
    });
    request.mockRejectedValue(new Error("index unavailable"));
    await expect(
      proxy.request(token, "memory.search", { query: "training" }),
    ).resolves.toMatchObject({
      personalMemoryUnavailable: true,
      personalWikiUnavailable: true,
      results: [{ vaultId: vault.id }],
    });
    await expect(
      proxy.request(token, "memory.search", {
        query: "training",
        vaultId: "personal:someone-else",
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
  });

  it("keeps backend score scales separate and exposes the retained Personal index", async () => {
    const { proxy, token, request, binding } = await setup();
    request.mockImplementation(async (method) =>
      method === "wiki.search"
        ? Array.from({ length: 3 }, (_, index) => ({
            corpus: "wiki",
            path: `concepts/training-${index}.md`,
            title: "Training",
            kind: "concept",
            snippet: "training",
            score: 100 - index,
            revision: "b".repeat(64),
            indexStatus: "failed",
            indexError: "Invalid Markdown metadata",
            nextRetryAt: 1234,
          }))
        : {
            agentId: binding.agentId,
            provider: "local",
            searchMode: "fts-only",
            results: [
              {
                path: "MEMORY.md",
                snippet: "training",
                source: "memory",
                score: 0.1,
                startLine: 1,
                endLine: 1,
                sourceVersion: "a".repeat(64),
              },
            ],
          },
    );
    const result = await proxy.request<{ results: Array<Record<string, unknown>> }>(
      token,
      "memory.search",
      { query: "training", maxResults: 2 },
    );
    expect(result.results.map((hit) => hit.source)).toEqual(["memory", "wiki"]);
    expect(result.results[1]).toMatchObject({
      revision: "b".repeat(64),
      indexStatus: "failed",
      indexError: "Invalid Markdown metadata",
      nextRetryAt: 1234,
    });
    expect(request).toHaveBeenCalledWith("memory.search", {
      agentId: binding.agentId,
      query: "training",
      maxResults: 2,
    });
  });

  it("enforces session, same-origin mutations and separate export rights over HTTP", async () => {
    const { store, user, token, vaultService, auth } = await setup();
    const vault = store.vaults.createVault({
      userId: user.id,
      name: "HTTP Vault",
    });
    store.vaults.saveDocument({
      userId: user.id,
      vaultId: vault.id,
      title: "Source",
      logicalPath: "source.md",
      content: "# Exact\r\n",
    });
    const server = createServer((req, res) => {
      void handleKnowledgeVaultHttp(
        req,
        res,
        {
          vaultService,
          authService: auth,
        },
        (request) => request.headers.origin === "https://vault.example",
      ).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing test server");
      }
      const base = `http://127.0.0.1:${address.port}/platformclaw/vaults`;
      const headers = { cookie: `platformclaw_session=${token}`, origin: "https://vault.example" };
      expect((await fetch(`${base}/export?vaultId=${vault.id}`)).status).toBe(401);
      expect(
        (
          await fetch(`${base}/import`, {
            method: "POST",
            headers: { cookie: headers.cookie },
            body: "bad",
          })
        ).status,
      ).toBe(403);
      const exported = await fetch(`${base}/export?vaultId=${vault.id}`, { headers });
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-type")).toBe("application/zip");
      const archive = await exported.arrayBuffer();
      const imported = await fetch(`${base}/import`, { method: "POST", headers, body: archive });
      expect(imported.status).toBe(201);
      const copy = (await imported.json()) as { id: string };
      expect(copy.id).not.toBe(vault.id);
      expect(
        store.vaults.snapshot({ userId: user.id, vaultId: copy.id }).selected?.documents,
      ).toHaveLength(1);
      const attachment = `${base}/attachment?${new URLSearchParams({ vaultId: vault.id, path: "timing.bin" })}`;
      const bytes = new Uint8Array([0, 255, 1, 2]);
      expect(
        (
          await fetch(attachment, {
            method: "PUT",
            headers: { ...headers, "content-type": "application/pdf" },
            body: bytes,
          })
        ).status,
      ).toBe(200);
      const downloaded = await fetch(attachment, { headers });
      expect(downloaded.headers.get("content-type")).toBe("application/pdf");
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
      const revision = store.vaults.snapshot({ userId: user.id, vaultId: vault.id }).selected!
        .attachments[0]!.revision;
      expect(
        (
          await fetch(`${attachment}&expectedRevision=${revision}`, {
            method: "PUT",
            headers: { ...headers, "content-type": "application/vnd.platformclaw.test+bin" },
            body: new Uint8Array([9, 8, 7]),
          })
        ).status,
      ).toBe(200);
      expect(
        store.vaults.snapshot({ userId: user.id, vaultId: vault.id }).selected!.attachments[0]!
          .mediaType,
      ).toBe("application/vnd.platformclaw.test+bin");
      expect(
        (
          await fetch(`${attachment}&expectedRevision=${revision}`, {
            method: "DELETE",
            headers,
          })
        ).status,
      ).toBe(409);
      store.vaults.setMember({
        userId: user.id,
        vaultId: vault.id,
        memberUserId: user.id,
        role: "owner",
      });
      expect((await fetch(`${base}/export?vaultId=${vault.id}`, { headers })).status).toBe(200);
      expect((await fetch(attachment, { headers })).status).toBe(200);
      const nextRevision = store.vaults.snapshot({ userId: user.id, vaultId: vault.id }).selected!
        .attachments[0]!.revision;
      expect(
        (
          await fetch(`${attachment}&expectedRevision=${nextRevision}`, {
            method: "DELETE",
            headers,
          })
        ).status,
      ).toBe(200);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("publishes only an explicitly reviewed complete personal source and rejects stale copies", async () => {
    const { proxy, token, store, user, request, binding } = await setup();
    const vault = store.vaults.createVault({
      userId: user.id,
      name: "Shared",
    });
    const sourceContent = "# Training\r\nOriginal body remains exact.\r\n";
    const expectedRevision = createHash("sha256").update(sourceContent).digest("hex");
    request.mockResolvedValue({
      path: "concepts/training.md",
      title: "Training",
      kind: "concept",
      displayContent: sourceContent,
      sourceContent,
      editMode: "body",
      editableContent: sourceContent,
      revision: expectedRevision,
    });
    const params = {
      lookup: "concepts/training.md",
      targetVaultId: vault.id,
      path: "training.md",
      expectedRevision,
    };
    await expect(
      proxy.request(token, "platformclaw.vault.publish", {
        ...params,
        expectedRevision: "c".repeat(64),
      }),
    ).rejects.toThrow("changed");
    expect(
      store.vaults.snapshot({ userId: user.id, vaultId: vault.id }).selected?.documents,
    ).toHaveLength(0);
    const published = await proxy.request<{ content: string }>(
      token,
      "platformclaw.vault.publish",
      params,
    );
    expect(published.content).toBe(sourceContent);
    const reviewedContent = "# Public copy\r\nOnly reviewed facts.\r\n";
    const edited = await proxy.request<{ content: string; title: string }>(
      token,
      "platformclaw.vault.publish",
      {
        ...params,
        path: undefined,
        title: "Reviewed public title",
        content: reviewedContent,
      },
    );
    expect(edited).toMatchObject({ title: "Reviewed public title", content: reviewedContent });
    await expect(
      proxy.request(token, "platformclaw.vault.publish", {
        ...params,
        content: reviewedContent,
        expectedRevision: "c".repeat(64),
      }),
    ).rejects.toThrow("changed");
    expect(request).toHaveBeenLastCalledWith("wiki.document.get", {
      agentId: binding.agentId,
      lookup: params.lookup,
    });
  });
});
