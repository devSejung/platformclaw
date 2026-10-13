import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformClawExecutionHandoffServer } from "./execution-handoff-http.js";
import {
  spaceContentProofPayloadHash,
  type SpaceContentMutation,
} from "./space-content-contracts.js";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";

const servers: PlatformClawExecutionHandoffServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function fixture() {
  const f = await createSpaceTestFixture();
  const conversation = f.store.spaces.createConversation(f.alice.user.id, f.space.id, {
    pageId: f.page.id,
    title: "Synthetic publishing",
    requestId: "synthetic-conversation",
  });
  const original = f.request.getMockImplementation()!;
  const authorization = {
    agentId: f.alice.binding.agentId,
    sessionKey: conversation.sessionKey,
    runtimeRunId: "runtime-one",
    admissionRunId: "admission-one",
  };
  const verify = vi.fn(async (params: unknown) => {
    if ((params as { proofId: string }).proofId !== "p".repeat(43)) {
      throw new Error("Untrusted proof");
    }
    return authorization;
  });
  f.request.mockImplementation(async (method, params) =>
    method === "platformclaw.spaces.run.authorize"
      ? await verify(params)
      : await original(method, params),
  );
  const socketPath =
    process.platform === "win32"
      ? String.raw`\\.\pipe\space-mutation-${randomUUID()}`
      : join(tmpdir(), `space-mutation-${randomUUID()}.sock`);
  const server = new PlatformClawExecutionHandoffServer(
    "review-synthetic-credential-1",
    {
      spaceService: f.service,
      resolveTarget: vi.fn(),
      resolveConnectionTarget: vi.fn(),
      changeTarget: vi.fn(),
      issueCredentialGrant: vi.fn(),
    },
    socketPath,
  );
  servers.push(server);
  await server.listen();
  const post = async (
    route: string,
    body: unknown,
    token = "review-synthetic-credential-1",
  ): Promise<{ status: number; body: Record<string, unknown> }> =>
    await new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body));
      const req = request(
        {
          socketPath,
          path: route,
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "content-length": payload.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  return { ...f, verify, post, authorization };
}

const QA = "/platformclaw/internal/spaces/qa/append";
const NOTES = "/platformclaw/internal/spaces/notes/patch";

describe("shared Space mutation transport", () => {
  it("keeps attributed post recall within its default serialized budget and returns the UI search title", async () => {
    const f = await fixture();
    await f.store.upsertPrincipal(
      {
        provider: "ldap",
        subject: f.alice.token,
        accountId: f.alice.token,
        employeeId: f.alice.token,
        displayName: "Synthetic author ".repeat(80),
      },
      Date.now(),
    );
    for (let index = 0; index < 5; index++) {
      f.store.spaces.content.mutate(f.authorization, {
        operation: "qa.append",
        requestId: `bounded-${index}`,
        expectedRevision: index + 1,
        body: "Synthetic publication " + "😀".repeat(1800),
      });
    }
    const params = {
      agentId: f.alice.binding.agentId,
      sessionKey: f.authorization.sessionKey,
      operation: "get",
      spaceId: f.space.id,
      pageId: f.page.id,
      view: "qa" as const,
    };
    const first = await f.service.agentRead(params);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(first.hasMore).toBe(true);
    const next = await f.service.agentRead({ ...params, qaCursor: first.nextCursor as string });
    expect(Buffer.byteLength(JSON.stringify(next), "utf8")).toBeLessThanOrEqual(8 * 1024);
    const ids = [
      ...(first.posts as Array<{ id: string }>),
      ...(next.posts as Array<{ id: string }>),
    ].map((post) => post.id);
    expect(new Set(ids).size).toBe(5);
    expect(
      f.store.spaces.content.searchQa(f.alice.user.id, f.space.id, "publication")[0],
    ).toMatchObject({ pageTitle: f.page.title, postId: expect.any(String) });
  });

  it("saves a post larger than the read request limit, replays its receipt and reads it through both public seams", async () => {
    const f = await fixture();
    const payload: SpaceContentMutation = {
      operation: "qa.append",
      requestId: "large-qa",
      expectedRevision: 1,
      body: "Synthetic answer ".repeat(320),
    };
    const input = { ...payload, proofId: "p".repeat(43) };
    const saved = await f.post(QA, input);
    expect(saved.status).toBe(200);
    expect(f.verify).toHaveBeenCalledWith({
      proofId: input.proofId,
      payloadHash: spaceContentProofPayloadHash(payload),
    });
    expect(saved.body).toMatchObject({
      revision: 2,
      receiptId: expect.any(String),
      link: expect.stringContaining("tab=qa&post="),
    });
    expect(saved.body).not.toHaveProperty("body");
    expect(await f.post(QA, input)).toEqual(saved);
    expect(f.store.spaces.page(f.alice.user.id, f.space.id, f.page.id).body).toBe(f.page.body);
    const read = await f.service.agentRead({
      agentId: f.alice.binding.agentId,
      sessionKey: f.authorization.sessionKey,
      operation: "get",
      spaceId: f.space.id,
      pageId: f.page.id,
      view: "qa",
      postId: saved.body.postId as string,
    });
    expect(read).toMatchObject({
      revision: 2,
      post: { id: saved.body.postId, authorId: f.alice.user.id, truncated: true },
    });
    const listed = await f.proxy.request(f.alice.token, "platformclaw.spaces.qa.list", {
      spaceId: f.space.id,
      pageId: f.page.id,
    });
    expect(listed).toMatchObject({ posts: [{ id: saved.body.postId }], revision: 2 });
    expect(f.request.mock.calls.map((call) => call[0])).not.toContain("chat.send");
  });

  it("rejects bearer-only identity selection, altered fields and wrong credentials before writing", async () => {
    const f = await fixture();
    const input = {
      operation: "qa.append",
      requestId: "forged",
      expectedRevision: 1,
      body: "Synthetic",
      proofId: "p".repeat(43),
    };
    expect((await f.post(QA, { ...input, actorUserId: f.bob.user.id })).status).toBe(400);
    expect(f.verify).not.toHaveBeenCalled();
    expect((await f.post(QA, { ...input, proofId: "q".repeat(43) })).status).toBe(403);
    expect((await f.post(QA, input, "wrong-synthetic-token")).status).toBe(401);
    expect(f.store.spaces.content.listQa(f.alice.user.id, f.space.id, f.page.id).posts).toEqual([]);
  });

  it("patches Notes without changing Q&A and rejects stale or revoked receipt replay", async () => {
    const f = await fixture();
    const input = {
      operation: "note.replace",
      requestId: "patch",
      expectedRevision: f.page.revision,
      oldText: "revision A",
      newText: "revision B",
      proofId: "p".repeat(43),
    };
    const saved = await f.post(NOTES, input);
    expect(saved.status).toBe(200);
    expect(f.store.spaces.page(f.alice.user.id, f.space.id, f.page.id).body).toBe(
      "Board revision B",
    );
    expect(f.store.spaces.content.qaRevision(f.alice.user.id, f.space.id, f.page.id)).toBe(1);
    expect((await f.post(NOTES, { ...input, requestId: "stale" })).status).toBe(409);
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", f.space.revision);
    const current = f.store.spaces.access(f.bob.user.id, f.space.id);
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, current.revision);
    expect((await f.post(NOTES, input)).status).toBe(403);
  });
});
