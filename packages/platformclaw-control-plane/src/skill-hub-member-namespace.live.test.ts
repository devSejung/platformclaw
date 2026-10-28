import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import { readBrowserJsonBody } from "./browser-http-shared.js";
import {
  handlePlatformClawSkillHubRequest,
  PLATFORMCLAW_SKILL_HUB_PATH,
} from "./browser-skill-hub-http.js";
import { OrganizationService } from "./organization-service.js";
import { IflytekSkillHubGovernanceClient } from "./skill-hub-governance-client.js";
import { SkillHubService } from "./skill-hub-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

// Disposable native registry only. Credentials remain in external mounted files.
const registryUrl = process.env.PLATFORMCLAW_SKILL_HUB_LIVE_URL;
const username = process.env.PLATFORMCLAW_SKILL_HUB_LIVE_USERNAME;
const passwordFile = process.env.PLATFORMCLAW_SKILL_HUB_LIVE_PASSWORD_FILE;

describe.skipIf(!registryUrl || !username || !passwordFile)(
  "Skill Hub employee policy against native registry",
  () => {
    it("publishes without org membership, preserves identity on retries, downloads, restricts sharing, and restores", async () => {
      const directory = await realpath(await mkdtemp(path.join(tmpdir(), "skillhub-policy-live-")));
      const workspaceRoot = path.join(directory, "workspaces");
      const store = new SqliteControlPlaneStore({
        databasePath: path.join(directory, "control.sqlite"),
        initialAdminAccountIds: ["proof.admin"],
        buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      });
      let loseCreateReply = true;
      const governance = new IflytekSkillHubGovernanceClient({
        baseUrl: registryUrl!,
        username: username!,
        password: (await readFile(passwordFile!, "utf8")).trim(),
        fetchImpl: async (input, init) => {
          const response = await fetch(input, init);
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          if (
            loseCreateReply &&
            init?.method === "POST" &&
            url.pathname === "/api/v1/namespaces" &&
            response.ok
          ) {
            loseCreateReply = false;
            await response.arrayBuffer();
            throw new TypeError("Synthetic lost reply after native commit");
          }
          return response;
        },
      });
      const service = new SkillHubService({
        store,
        governance,
        organization: new OrganizationService(store),
        workspaceRoot,
        maxPackageBytes: 1024 * 1024,
        buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
        adminRpc: {
          call: async () => {
            throw new Error("Unexpected Gateway RPC in native publication/download proof");
          },
        },
        authService: new BrowserAuthService({
          store,
          authenticator: {
            authenticatePassword: async () => ({ status: "rejected", message: "unused" }),
          },
          provisioner: { provisionOrRefresh: async () => undefined },
        }),
      });
      const server = createServer((req, res) => {
        void handlePlatformClawSkillHubRequest(req, res, {
          service,
          readJsonBody: readBrowserJsonBody,
          isMutationOriginAllowed: (request) => request.headers.origin === "http://proof.test",
        }).then((handled) => {
          if (!handled) {
            res.writeHead(404).end();
          }
        });
      });
      try {
        const users = new Map<string, string>();
        const slug = `proof-policy-${randomUUID().slice(0, 8)}`;
        for (const name of ["admin", "author", "reader"]) {
          const accountId = `proof.${name}`;
          const { user } = await store.upsertPrincipal(
            { provider: "ldap", subject: accountId, accountId, employeeId: accountId, groups: [] },
            Date.now(),
          );
          users.set(name, user.id);
          const { binding } = await store.reservePersonalAgent(user.id, Date.now());
          await store.transitionAgent({
            bindingId: binding.id,
            state: "active",
            changedAt: Date.now(),
          });
          await store.createBrowserSession({
            userId: user.id,
            tokenHash: hashBrowserSessionToken(`${name}-token`),
            createdAt: Date.now(),
          });
          const dir = path.join(workspaceRoot, binding.agentId, "skills", slug);
          await mkdir(dir, { recursive: true });
          await writeFile(
            path.join(dir, "SKILL.md"),
            `---\nname: ${slug}\ndescription: Synthetic policy proof\nversion: 1.0.0\n---\nReturn verified.\n`,
          );
        }
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing listener");
        }
        const request = (actor: string, route: string, body?: unknown, method?: string) =>
          fetch(`http://127.0.0.1:${address.port}${PLATFORMCLAW_SKILL_HUB_PATH}${route}`, {
            method: method ?? (body === undefined ? "GET" : "POST"),
            headers: {
              cookie: `platformclaw_session=${actor}-token`,
              origin: "http://proof.test",
              "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        expect(await (await request("author", "/config")).json()).toMatchObject({
          defaultSharing: "PUBLIC",
          admin: false,
        });
        const publication = {
          operationId: randomUUID(),
          skill: slug,
          source: "platform_server",
          version: "1.0.0",
        };
        expect((await request("author", "/publish", publication)).status).toBe(502);
        const response = await request("author", "/publish", publication);
        expect(response.status).toBe(200);
        const published = (await response.json()) as { id: string; slug: string; version: string };
        expect(await (await request("author", "/publish", publication)).json()).toEqual(published);
        const entry = (await store.skillHubCatalog.get(published.id))!;
        expect(entry).toMatchObject({
          sharing: { mode: "PUBLIC" },
          ownerUserId: users.get("author"),
        });
        expect(
          (
            await governance.getArtifactSkill({
              namespace: entry.namespace,
              slug,
              expectedSkillId: entry.registryId!,
            })
          ).visibility,
        ).toBe("PRIVATE");
        const detailRoute = `/skills/by-id/${published.id}`;
        expect((await request("reader", detailRoute)).status).toBe(200);
        const downloaded = await request("reader", `${detailRoute}/download?version=1.0.0`);
        expect(downloaded.status).toBe(200);
        const zip = await JSZip.loadAsync(await downloaded.arrayBuffer());
        expect(await zip.file("SKILL.md")!.async("string")).toContain(`name: ${slug}`);
        expect((await request("reader", `${detailRoute}/history`)).status).toBe(200);
        const team = await store.createManagedScope({
          actorUserId: users.get("admin")!,
          kind: "team",
          name: "Other team",
          createdAt: Date.now(),
        });
        await store.setManagedScopeMembership({
          actorUserId: users.get("admin")!,
          scopeId: team.id,
          userId: users.get("reader")!,
          role: "member",
          reason: "Synthetic proof",
          changedAt: Date.now(),
        });
        const selected = await request(
          "author",
          detailRoute,
          {
            expectedRevision: entry.revision,
            sharing: { mode: "SELECTED", userIds: [], scopeIds: [team.id] },
            summary: "Catalog summary",
            tags: ["proof"],
          },
          "PATCH",
        );
        expect(selected.status).toBe(200);
        const selectedRevision = ((await selected.json()) as { revision: number }).revision;
        expect((await request("reader", detailRoute)).status).toBe(200);
        const hidden = await request(
          "author",
          detailRoute,
          {
            expectedRevision: selectedRevision,
            sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
          },
          "PATCH",
        );
        expect(hidden.status).toBe(200);
        const privateRevision = ((await hidden.json()) as { revision: number }).revision;
        expect((await request("reader", detailRoute)).status).toBe(404);
        expect((await request("reader", `${detailRoute}/download?version=1.0.0`)).status).toBe(404);
        const deleted = await request("author", `${detailRoute}/delete`, {
          expectedRevision: privateRevision,
        });
        expect(deleted.status).toBe(200);
        expect((await request("author", detailRoute)).status).toBe(404);
        const deletedRevision = ((await deleted.json()) as { revision: number }).revision;
        expect(
          (await request("author", `${detailRoute}/restore`, { expectedRevision: deletedRevision }))
            .status,
        ).toBe(200);
        expect((await request("author", detailRoute)).status).toBe(200);
        expect((await request("reader", detailRoute)).status).toBe(404);
      } finally {
        service.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        store.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 90_000);
  },
);
