import { describe, expect, it } from "vitest";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import { createTestRegistry } from "./server/__tests__/test-utils.js";

describe("in-process Gateway dispatch", () => {
  it("uses the plugin registry that owns the calling HTTP route", async () => {
    const handler: GatewayRequestHandler = ({ respond }) => {
      respond(true, { source: "route-registry" });
    };
    const pluginRegistry = createTestRegistry({
      gatewayHandlers: { "test.route.echo": handler },
    });

    await expect(
      dispatchGatewayRequestInProcessRaw(
        "test.route.echo",
        {},
        {
          client: null,
          context: {} as GatewayRequestContext,
          pluginRegistry,
        },
      ),
    ).resolves.toEqual({ ok: true, payload: { source: "route-registry" } });
  });
});
