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
import type { PlatformUser } from "./contracts.js";
import { OrganizationService } from "./organization-service.js";
import { IflytekSkillHubAdapter } from "./skill-hub-adapter.js";
import { IflytekSkillHubGovernanceClient } from "./skill-hub-governance-client.js";
import { SkillHubService } from "./skill-hub-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

// Run only against a disposable registry: this proof creates real namespaces and releases.
// Credentials remain in mounted files; neither test output nor source includes their values.
const registryUrl = process.env.PLATFORMCLAW_SKILL_HUB_LIVE_URL;
const username = process.env.PLATFORMCLAW_SKILL_HUB_LIVE_USERNAME;
const passwordFile = process.env.PLATFORMCLAW_SKILL_HUB_LIVE_PASSWORD_FILE;
const tokenFile = process.env.PLATFORMCLAW_SKILL_HUB_LIVE_TOKEN_FILE;

describe.skipIf(!registryUrl || !username || !passwordFile || !tokenFile)(
  "Skill Hub member namespace creation against the pinned live registry",
  () => {
    it("creates, retries after a lost commit reply and restart, and publishes through the member browser boundary", async () => {
      const directory = await realpath(await mkdtemp(path.join(tmpdir(), "skillhub-member-live-")));
      const databasePath = path.join(directory, "control.sqlite");
      const workspaceRoot = path.join(directory, "workspaces");
      const suffix = randomUUID().slice(0, 8);
      const globalNamespace = `proof-global-${suffix}`;
      const teamNamespace = `proof-team-${suffix}`;
      const collisionNamespace = `proof-native-${suffix}`;
      const lostNamespace = `proof-lost-${suffix}`;
      const skillSlug = `proof-skill-${suffix}`;
      const nativeSlug = `proof-native-skill-${suffix}`;
      const sharedSlug = `proof-shared-skill-${suffix}`;
      const password = (await readFile(passwordFile!, "utf8")).trim();
      const token = (await readFile(tokenFile!, "utf8")).trim();
      let namespacePosts = 0;
      let loseNextCreateReply = false;
      const registryFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (init?.method === "POST" && url.pathname === "/api/v1/namespaces") {
          namespacePosts += 1;
          if (loseNextCreateReply && response.ok) {
            loseNextCreateReply = false;
            // The native transaction has committed. Drop only its response at the HTTP seam.
            await response.arrayBuffer();
            throw new TypeError("simulated connection loss after namespace commit");
          }
        }
        return response;
      };
      const createGovernance = () =>
        new IflytekSkillHubGovernanceClient({
          baseUrl: registryUrl!,
          username: username!,
          password,
          fetchImpl: registryFetch,
        });
      let governance = createGovernance();
      const registryAdapter = new IflytekSkillHubAdapter({
        baseUrl: registryUrl!,
        token,
        maxArchiveBytes: 1024 * 1024,
      });
      const createStore = () =>
        new SqliteControlPlaneStore({
          databasePath,
          initialAdminAccountIds: ["proof.admin"],
          buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
        });
      let store = createStore();
      let service: SkillHubService | undefined;
      const server = createServer((req, res) => {
        void handlePlatformClawSkillHubRequest(req, res, {
          service: service!,
          readJsonBody: readBrowserJsonBody,
          isMutationOriginAllowed: (request) => request.headers.origin === "http://proof.test",
        }).then((handled) => {
          if (!handled) {
            res.writeHead(404).end();
          }
        });
      });
      try {
        const users = new Map<string, PlatformUser>();
        for (const name of ["admin", "member", "outsider"]) {
          const accountId = `proof.${name}`;
          const { user } = await store.upsertPrincipal(
            { provider: "ldap", subject: accountId, accountId, employeeId: accountId, groups: [] },
            Date.now(),
          );
          users.set(name, user);
          const reservation = await store.reservePersonalAgent(user.id, Date.now());
          await store.transitionAgent({
            bindingId: reservation.binding.id,
            state: "active",
            changedAt: Date.now(),
          });
          await store.createBrowserSession({
            userId: user.id,
            tokenHash: hashBrowserSessionToken(`${name}-token`),
            createdAt: Date.now(),
          });
          for (const slug of [skillSlug, nativeSlug, sharedSlug]) {
            const skillDir = path.join(workspaceRoot, reservation.binding.agentId, "skills", slug);
            await mkdir(skillDir, { recursive: true });
            await writeFile(
              path.join(skillDir, "SKILL.md"),
              `---\nname: ${slug}\ndescription: Synthetic live member publication proof\nversion: 1.0.0\n---\nReturn the word verified.\n`,
            );
          }
        }
        const member = users.get("member")!;
        expect(member.globalRole).toBe("member");
        const team = await store.createManagedScope({
          actorUserId: users.get("admin")!.id,
          kind: "team",
          name: "Synthetic proof team",
          createdAt: Date.now(),
        });
        await store.setManagedScopeMembership({
          actorUserId: users.get("admin")!.id,
          scopeId: team.id,
          userId: member.id,
          role: "member",
          reason: "Synthetic live proof membership",
          changedAt: Date.now(),
        });
        const createService = () =>
          new SkillHubService({
            store,
            organization: new OrganizationService(store),
            adapter: registryAdapter,
            governance,
            adminRpc: {
              call: async () => {
                throw new Error("Unexpected Gateway RPC");
              },
            },
            authService: new BrowserAuthService({
              store,
              authenticator: {
                authenticatePassword: async () => ({ status: "rejected", message: "unused" }),
              },
              provisioner: { provisionOrRefresh: async () => undefined },
            }),
            workspaceRoot,
            allowedNamespaces: ["unbound-extra"],
            maxPackageBytes: 1024 * 1024,
            buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
          });
        service = createService();
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Live proof listener failed");
        }
        const request = async (
          actor: string,
          route: string,
          body?: unknown,
          origin = "http://proof.test",
        ) => {
          const response = await fetch(
            `http://127.0.0.1:${address.port}${PLATFORMCLAW_SKILL_HUB_PATH}${route}`,
            {
              method: body === undefined ? "GET" : "POST",
              headers: {
                cookie: `platformclaw_session=${actor}-token`,
                origin,
                "content-type": "application/json",
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
          );
          return {
            status: response.status,
            body: (await response.json()) as Record<string, unknown>,
          };
        };
        expect((await request("member", "/config")).body).toMatchObject({
          admin: false,
          defaultNamespace: "global",
          namespaces: ["global"],
        });
        expect(await store.getSkillHubNamespaceBinding("global")).toMatchObject({
          scopeKind: "global",
          accessState: "active",
        });
        // No organization or explicit Global allowlist entry is needed to publish.
        expect((await request("outsider", "/config")).body).toMatchObject({
          admin: false,
          defaultNamespace: "global",
          namespaces: ["global"],
        });
        const globalRequest = { namespace: globalNamespace, scopeKind: "global" };
        expect(
          (await request("member", "/namespaces", globalRequest, "http://untrusted.test")).status,
        ).toBe(403);
        expect(namespacePosts).toBe(0);
        expect((await request("member", "/namespaces", globalRequest)).status).toBe(200);
        expect(await store.getSkillHubNamespaceBinding(globalNamespace)).toMatchObject({
          scopeKind: "global",
          accessState: "active",
          createdByUserId: member.id,
        });
        const postsAfterCreate = namespacePosts;
        expect((await request("member", "/namespaces", globalRequest)).status).toBe(200);
        expect(namespacePosts).toBe(postsAfterCreate);
        expect((await request("member", "/admin/namespaces")).status).toBe(403);
        expect(
          (
            await request("outsider", "/namespaces", {
              namespace: `denied-${suffix}`,
              scopeKind: "team",
              scopeId: team.id,
            })
          ).status,
        ).toBe(403);
        expect(namespacePosts).toBe(postsAfterCreate);
        expect(
          (
            await request("member", "/namespaces", {
              namespace: teamNamespace,
              scopeKind: "team",
              scopeId: team.id,
            })
          ).status,
        ).toBe(200);
        await governance.createNamespace!({
          namespace: collisionNamespace,
          operationId: randomUUID(),
        });
        expect(
          (
            await request("member", "/namespaces", {
              namespace: collisionNamespace,
              scopeKind: "global",
            })
          ).status,
        ).toBe(409);
        expect(await store.getSkillHubNamespaceBinding(collisionNamespace)).toBeNull();

        loseNextCreateReply = true;
        const recoveryRequest = { namespace: lostNamespace, scopeKind: "global" };
        expect((await request("member", "/namespaces", recoveryRequest)).status).toBe(503);
        expect(await store.getSkillHubNamespaceBinding(lostNamespace)).toBeNull();
        const postsAfterLoss = namespacePosts;
        service.close();
        store.close();
        store = createStore();
        governance = createGovernance();
        service = createService();
        expect((await request("member", "/namespaces", recoveryRequest)).status).toBe(200);
        expect(namespacePosts).toBe(postsAfterLoss);
        expect(await store.getSkillHubNamespaceBinding(lostNamespace)).toMatchObject({
          accessState: "active",
        });

        expect((await request("member", "/config")).body).toMatchObject({
          admin: false,
          defaultNamespace: "global",
          namespaces: expect.arrayContaining([globalNamespace, teamNamespace, lostNamespace]),
        });
        const nativeArchive = new JSZip();
        nativeArchive.file(
          "SKILL.md",
          `---\nname: ${nativeSlug}\ndescription: Original native registry skill\nversion: 1.0.0\n---\nPreserve the native registry release.\n`,
        );
        await registryAdapter.publish({
          namespace: "global",
          filename: `${nativeSlug}.zip`,
          archive: await nativeArchive.generateAsync({ type: "nodebuffer" }),
          visibility: "PRIVATE",
        });
        const nativeBefore = await registryAdapter.getSkill("global", nativeSlug);
        const basicDenied = await request("member", "/publish", {
          namespace: "global",
          skill: nativeSlug,
          source: "platform_server",
          version: "2.0.0",
          visibility: "PRIVATE",
        });
        expect(basicDenied).toMatchObject({
          status: 403,
          body: { details: { code: "skill-hub-untracked-skill" } },
        });
        const replacementArchive = new JSZip();
        replacementArchive.file(
          "SKILL.md",
          `---\nname: ${nativeSlug}\ndescription: Forbidden employee replacement\nversion: 2.0.0\n---\nThis upload must be rejected.\n`,
        );
        const replacementBytes = await replacementArchive.generateAsync({ type: "nodebuffer" });
        const uploadDenied = await fetch(
          `http://127.0.0.1:${address.port}${PLATFORMCLAW_SKILL_HUB_PATH}/publish/upload?namespace=global&slug=${nativeSlug}&version=2.0.0&visibility=PRIVATE`,
          {
            method: "POST",
            headers: {
              cookie: "platformclaw_session=member-token",
              origin: "http://proof.test",
              "content-type": "application/zip",
            },
            body: new Uint8Array(replacementBytes),
          },
        );
        expect(uploadDenied.status).toBe(403);
        expect(await uploadDenied.json()).toMatchObject({
          details: { code: "skill-hub-untracked-skill" },
        });
        expect(await store.getSkillHubOwnership("global", nativeSlug)).toBeNull();
        expect(await registryAdapter.getSkill("global", nativeSlug)).toEqual(nativeBefore);
        expect(
          (await registryAdapter.listVersions("global", nativeSlug)).map(
            (version) => version.version,
          ),
        ).toEqual(["1.0.0"]);
        for (const namespace of ["global", globalNamespace]) {
          const publication = await request("member", "/publish", {
            namespace,
            skill: skillSlug,
            source: "platform_server",
            version: "1.0.0",
            visibility: "PRIVATE",
          });
          expect(publication).toMatchObject({
            status: 200,
            body: { namespace, slug: skillSlug, version: "1.0.0" },
          });
          expect(await store.getSkillHubOwnership(namespace, skillSlug)).toMatchObject({
            ownerUserId: member.id,
            currentVersion: "1.0.0",
          });
          expect((await request("member", `/skills/${namespace}/${skillSlug}`)).status).toBe(200);
          expect((await request("outsider", `/skills/${namespace}/${skillSlug}`)).status).toBe(404);
        }
        expect(
          await request("outsider", "/publish", {
            namespace: "global",
            skill: sharedSlug,
            source: "platform_server",
            version: "1.0.0",
            visibility: "NAMESPACE_ONLY",
          }),
        ).toMatchObject({
          status: 200,
          body: {
            namespace: "global",
            slug: sharedSlug,
            version: "1.0.0",
            visibility: "NAMESPACE_ONLY",
          },
        });
        // The normal worker owns approval. Allow two 30-second queue passes and
        // await its persisted completion notification without advancing its clock.
        await expect
          .poll(async () => await request("outsider", "/notifications"), {
            interval: 1_000,
            timeout: 60_000,
          })
          .toMatchObject({
            status: 200,
            body: {
              items: expect.arrayContaining([
                expect.objectContaining({
                  kind: "scan-approved",
                  namespace: "global",
                  slug: sharedSlug,
                }),
              ]),
            },
          });
        const sharedSkill = await registryAdapter.getSkill("global", sharedSlug);
        const sharedVersion = await registryAdapter.getVersionState("global", sharedSlug, "1.0.0");
        expect(sharedVersion.status).toBe("PUBLISHED");
        const sharedAudits = await registryAdapter.listSecurityAudits(
          sharedSkill.id,
          sharedVersion.id,
        );
        expect(sharedAudits.length).toBeGreaterThan(0);
        for (const audit of sharedAudits) {
          expect(audit).toMatchObject({ isSafe: true, scannedAt: expect.any(String) });
          expect(audit.failedAt).toBeUndefined();
        }
        expect(await store.listAuditEvents(100)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              eventType: "skill-hub.review.auto-approved",
              targetId: `global/${sharedSlug}@1.0.0`,
            }),
          ]),
        );
        expect(await request("member", `/skills/global/${sharedSlug}`)).toMatchObject({
          status: 200,
          body: {
            skill: { visibility: "NAMESPACE_ONLY" },
            versions: expect.arrayContaining([
              expect.objectContaining({
                version: "1.0.0",
                status: "PUBLISHED",
                downloadAvailable: true,
              }),
            ]),
            scanner: { status: "passed" },
          },
        });
        expect((await request("outsider", `/skills/global/${skillSlug}`)).status).toBe(404);
      } finally {
        service?.close();
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
