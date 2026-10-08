import type { AddressInfo } from "node:net";
import type { EventFrame } from "@openclaw/gateway-protocol";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";
import { PlatformClawWebIngressServer } from "./web-ingress-server.js";
import { createFrameQueue, FakeGateway, isRecord } from "./web-ingress-test-harness.js";

const PUBLIC_ORIGIN = "https://platformclaw.example";

describe("authenticated compaction WebSocket ingress", () => {
  it("isolates two employees' progress, restores markers after reconnect, and rejects foreign sessions", async () => {
    const f = await createSpaceTestFixture();
    const gateway = new FakeGateway();
    const actors = [f.alice, f.bob];
    const markers = new Map<string, Record<string, unknown>>();
    f.request.mockImplementation(async (method, rawParams) => {
      if (!isRecord(rawParams)) {
        throw new Error("expected pinned request parameters");
      }
      const sessionKey = String(rawParams.sessionKey ?? rawParams.key);
      const actor = actors.find((candidate) => candidate.binding.agentId === rawParams.agentId);
      if (!actor || sessionKey !== `agent:${actor.binding.agentId}:main`) {
        throw new Error("upstream received an unowned compaction session");
      }
      const runId = `compact-${actor.binding.agentId}`;
      const itemId = `item-${actor.binding.agentId}`;
      if (method === "sessions.compact") {
        gateway.emit({
          type: "event",
          event: "agent",
          payload: { sessionKey, runId, stream: "compaction", data: { phase: "start", itemId } },
        });
        markers.set(sessionKey, {
          role: "system",
          content: [{ type: "text", text: "Compaction" }],
          timestamp: 1,
          __openclaw: {
            kind: "compaction",
            id: `entry-${itemId}`,
            runId,
            itemId,
            tokensBefore: 900_000,
            tokensAfter: 24_700,
          },
        });
        gateway.emit({
          type: "event",
          event: "agent",
          payload: {
            sessionKey,
            runId,
            stream: "compaction",
            data: { phase: "end", itemId, completed: true, willRetry: false },
          },
        });
        return {
          ok: true,
          key: sessionKey,
          compacted: true,
          result: { tokensBefore: 900_000, tokensAfter: 24_700 },
        };
      }
      if (method === "chat.history" || method === "chat.startup") {
        return {
          sessionKey,
          sessionInfo: { key: sessionKey, agentId: actor.binding.agentId },
          messages: [markers.get(sessionKey)],
          ...(method === "chat.startup"
            ? {
                agentsList: {
                  agents: actors.map((candidate) => ({ id: candidate.binding.agentId })),
                },
              }
            : {}),
        };
      }
      throw new Error(`unexpected Gateway method: ${method}`);
    });
    const server = new PlatformClawWebIngressServer({
      publicOrigin: PUBLIC_ORIGIN,
      authService: f.auth,
      gatewayProxy: f.proxy,
      gateway,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: () => {},
      },
    });
    const sockets: WebSocket[] = [];
    try {
      await server.listen({ host: "127.0.0.1", port: 0 });
      const port = (server.address() as AddressInfo).port;
      async function connect(actor: (typeof actors)[number]) {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/platformclaw/gateway`, {
          origin: PUBLIC_ORIGIN,
          headers: { Cookie: `platformclaw_session=${actor.token}` },
        });
        sockets.push(socket);
        const received: unknown[] = [];
        socket.on("message", (data) => {
          const text = Buffer.isBuffer(data)
            ? data.toString("utf8")
            : data instanceof ArrayBuffer
              ? Buffer.from(data).toString("utf8")
              : Buffer.concat(data).toString("utf8");
          received.push(JSON.parse(text));
        });
        const nextFrame = createFrameQueue(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        });
        let requestId = 0;
        async function call(method: string, params: Record<string, unknown>) {
          const id = `request-${++requestId}`;
          socket.send(JSON.stringify({ type: "req", id, method, params }));
          return await nextFrame(
            (frame) => isRecord(frame) && frame.type === "res" && frame.id === id,
          );
        }
        expect(
          await call("connect", {
            minProtocol: 4,
            maxProtocol: 4,
            client: {
              id: "openclaw-control-ui",
              version: "test",
              platform: "web",
              mode: "webchat",
            },
          }),
        ).toMatchObject({
          ok: true,
          payload: { snapshot: { sessionDefaults: { defaultAgentId: actor.binding.agentId } } },
        });
        return {
          actor,
          socket,
          received,
          call,
          async flushEvents() {
            await nextFrame((frame) => isRecord(frame) && frame.event === "tick");
          },
        };
      }
      let clients = await Promise.all(actors.map(connect));
      const compacted = await Promise.all(
        clients.map((client) =>
          client.call("sessions.compact", { key: `agent:${client.actor.binding.agentId}:main` }),
        ),
      );
      for (const response of compacted) {
        expect(response).toMatchObject({
          ok: true,
          payload: { compacted: true, result: { tokensBefore: 900_000, tokensAfter: 24_700 } },
        });
      }
      // Per-connection event chains process this barrier after every compaction event.
      gateway.emit({ type: "event", event: "tick", payload: {} } satisfies EventFrame);
      await Promise.all(clients.map((client) => client.flushEvents()));
      for (const client of clients) {
        const runId = `compact-${client.actor.binding.agentId}`;
        const itemId = `item-${client.actor.binding.agentId}`;
        expect(
          client.received.filter((frame) => isRecord(frame) && frame.event === "agent"),
        ).toEqual([
          {
            type: "event",
            event: "agent",
            seq: 1,
            payload: {
              sessionKey: `agent:${client.actor.binding.agentId}:main`,
              runId,
              stream: "compaction",
              data: { phase: "start", itemId },
            },
          },
          {
            type: "event",
            event: "agent",
            seq: 2,
            payload: {
              sessionKey: `agent:${client.actor.binding.agentId}:main`,
              runId,
              stream: "compaction",
              data: { phase: "end", itemId, completed: true, willRetry: false },
            },
          },
        ]);
      }
      const callsBeforeForeignRequests = f.request.mock.calls.length;
      for (let index = 0; index < clients.length; index += 1) {
        const client = clients[index]!;
        const foreign = actors[(index + 1) % actors.length]!;
        const foreignKey = `agent:${foreign.binding.agentId}:main`;
        for (const method of ["chat.history", "chat.startup", "sessions.compact"]) {
          expect(
            await client.call(
              method,
              method === "sessions.compact" ? { key: foreignKey } : { sessionKey: foreignKey },
            ),
          ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        }
      }
      expect(f.request).toHaveBeenCalledTimes(callsBeforeForeignRequests);
      await Promise.all(
        clients.map(
          ({ socket }) =>
            new Promise<void>((resolve) => {
              socket.once("close", resolve);
              socket.close();
            }),
        ),
      );
      clients = await Promise.all(actors.map(connect));
      for (const client of clients) {
        const sessionKey = `agent:${client.actor.binding.agentId}:main`;
        for (const method of ["chat.history", "chat.startup"]) {
          expect(await client.call(method, { sessionKey })).toMatchObject({
            ok: true,
            payload: {
              sessionKey,
              messages: [markers.get(sessionKey)],
              ...(method === "chat.startup"
                ? { agentsList: { agents: [{ id: client.actor.binding.agentId }] } }
                : {}),
            },
          });
        }
      }
    } finally {
      for (const socket of sockets) {
        socket.terminate();
      }
      await server.close();
    }
  });
});
