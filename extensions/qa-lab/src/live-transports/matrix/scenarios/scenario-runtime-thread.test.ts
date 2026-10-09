import { afterEach, describe, expect, it, vi } from "vitest";
import { runSubagentThreadSpawnScenario } from "./scenario-runtime-thread.js";

const roomId = "!room:matrix-qa.test";
const sutUserId = "@sut:matrix-qa.test";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Matrix subagent thread scenario", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['sessions_spawn(mode="session")', "thread=true"])(
    "reports the current core binding failure for %s without waiting for an intro",
    async (request) => {
      const failure = `${request} is only available on channels that expose thread bindings (e.g. Discord threads, Slack threads, Telegram forum topics).`;
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.pathname.endsWith("/sync")) {
          expect(url.searchParams.get("since")).toBe("spawn-start");
          return jsonResponse({
            next_batch: "spawn-end",
            rooms: {
              join: {
                [roomId]: {
                  timeline: {
                    events: [
                      {
                        event_id: "$spawn-error",
                        sender: sutUserId,
                        type: "m.room.message",
                        content: { msgtype: "m.text", body: failure },
                      },
                    ],
                  },
                },
              },
            },
          });
        }
        if (url.pathname.includes("/send/m.room.message/")) {
          return jsonResponse({ event_id: "$trigger" });
        }
        throw new Error(`unexpected Matrix QA request: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        runSubagentThreadSpawnScenario({
          baseUrl: "http://127.0.0.1:28008",
          driverAccessToken: "driver-token",
          driverUserId: "@driver:matrix-qa.test",
          observedEvents: [],
          observerAccessToken: "observer-token",
          observerUserId: "@observer:matrix-qa.test",
          roomId,
          sutAccessToken: "sut-token",
          syncState: { driver: "spawn-start" },
          sutUserId,
          timeoutMs: 1_000,
          topology: { defaultRoomId: roomId, defaultRoomKey: "default", rooms: [] },
        }),
      ).rejects.toThrow(`Matrix subagent thread binding unavailable: ${failure}`);
    },
  );
});
