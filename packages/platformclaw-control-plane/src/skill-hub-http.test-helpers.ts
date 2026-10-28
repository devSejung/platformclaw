import { createServer, type Server } from "node:http";
import { afterEach } from "vitest";
import { readBrowserJsonBody } from "./browser-http-shared.js";
import {
  handlePlatformClawSkillHubRequest,
  PLATFORMCLAW_SKILL_HUB_PATH,
} from "./browser-skill-hub-http.js";
import { createSkillHubServiceFixture } from "./skill-hub-service.test-fixtures.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }),
  );
});

export async function createSkillHubHttpFixture() {
  const fixture = await createSkillHubServiceFixture([], undefined, { registrySkill: "absent" });
  const server = createServer((request, response) => {
    void handlePlatformClawSkillHubRequest(request, response, {
      service: fixture.service,
      readJsonBody: readBrowserJsonBody,
      isMutationOriginAllowed: (incoming) => incoming.headers.origin === "http://skillhub.test",
    }).then((handled) => {
      if (!handled) {
        response
          .writeHead(404, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "unhandled route" }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Skill Hub test server is unavailable");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const request = async (
    route: string,
    options: {
      method?: string;
      token?: string | null;
      origin?: string;
      json?: unknown;
      bytes?: Uint8Array;
      contentType?: string;
    } = {},
  ) => {
    const headers = new Headers({ origin: options.origin ?? "http://skillhub.test" });
    if (options.token !== null) {
      headers.set("cookie", `platformclaw_session=${options.token ?? fixture.actor.token}`);
    }
    if (options.json !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (options.contentType) {
      headers.set("content-type", options.contentType);
    }
    const response = await fetch(`${origin}${PLATFORMCLAW_SKILL_HUB_PATH}${route}`, {
      method: options.method ?? "GET",
      headers,
      body:
        options.json !== undefined
          ? JSON.stringify(options.json)
          : options.bytes
            ? Buffer.from(options.bytes)
            : undefined,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const body: unknown = response.headers.get("content-type")?.includes("application/json")
      ? JSON.parse(bytes.toString("utf8"))
      : undefined;
    return { status: response.status, headers: response.headers, bytes, body };
  };
  return { ...fixture, request, origin };
}
