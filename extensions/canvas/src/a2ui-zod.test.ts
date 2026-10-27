import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { v0_8 } from "@a2ui/lit";
import { describe, expect, it } from "vitest";

// Resolve the public core entry through its owning renderer dependency. Core is
// intentionally not a second direct Canvas dependency.
const rendererRequire = createRequire(createRequire(import.meta.url).resolve("@a2ui/lit"));
const core = await import(pathToFileURL(rendererRequire.resolve("@a2ui/web_core/v0_9")).href);

describe("Canvas A2UI Zod contract", () => {
  it("processes v0.8 surfaces, recursive data, rendering, and deletion", () => {
    const processor = new v0_8.Data.A2uiMessageProcessor();
    processor.processMessages([
      {
        surfaceUpdate: {
          surfaceId: "test",
          components: [{ id: "root", component: { Text: { text: { path: "/greeting" } } } }],
        },
      },
      {
        dataModelUpdate: {
          surfaceId: "test",
          contents: [{ key: "greeting", valueString: "Hello" }],
        },
      },
      { beginRendering: { surfaceId: "test", root: "root" } },
    ]);
    expect(processor.getSurfaces().get("test")?.rootComponentId).toBe("root");
    expect(processor.getSurfaces().get("test")?.dataModel.get("greeting")).toBe("Hello");
    expect(() => processor.processMessages([{}])).toThrow();
    expect(() =>
      processor.processMessages(JSON.parse('[{"beginRendering":{"surfaceId":"test","root":7}}]')),
    ).toThrow();
    processor.processMessages([{ deleteSurface: { surfaceId: "test" } }]);
    expect(processor.getSurfaces().size).toBe(0);
  });

  it("keeps v0.9 record values and malformed client/server messages validated", () => {
    const action = {
      name: "submit",
      surfaceId: "test",
      sourceComponentId: "button",
      timestamp: "2026-10-24T00:00:00Z",
      context: { label: "value", nested: { count: 2 } },
    };
    expect(core.A2uiClientActionSchema.parse(action)).toEqual(action);
    expect(
      core.A2uiClientDataModelSchema.parse({ version: "v0.9", surfaces: { test: { x: 1 } } }),
    ).toEqual({ version: "v0.9", surfaces: { test: { x: 1 } } });
    expect(
      core.A2uiClientDataModelSchema.safeParse({ version: "v0.9", surfaces: { test: 7 } }).success,
    ).toBe(false);
    expect(
      core.A2uiMessageSchema.safeParse({ version: "v0.9", createSurface: { surfaceId: 7 } })
        .success,
    ).toBe(false);
    expect(
      core.A2uiMessageSchema.safeParse({
        version: "v0.9",
        updateComponents: {
          surfaceId: "test",
          components: [],
        },
      }).success,
    ).toBe(false);
  });

  it("scrapes v0.9 dynamic/action/child bindings and emits real inline capability schemas", () => {
    const text = core.BASIC_COMPONENTS.find(
      (component: { name: string }) => component.name === "Text",
    );
    const row = core.BASIC_COMPONENTS.find(
      (component: { name: string }) => component.name === "Row",
    );
    const button = core.BASIC_COMPONENTS.find(
      (component: { name: string }) => component.name === "Button",
    );
    expect(core.scrapeSchemaBehavior(text.schema).shape.text.type).toBe("DYNAMIC");
    expect(core.scrapeSchemaBehavior(row.schema).shape.children.type).toBe("STRUCTURAL");
    expect(core.scrapeSchemaBehavior(button.schema).shape.action.type).toBe("ACTION");
    const catalog = new core.Catalog("synthetic", core.BASIC_COMPONENTS, core.BASIC_FUNCTIONS);
    const processor = new core.MessageProcessor([catalog]);
    const capabilities = processor.getClientCapabilities({ includeInlineCatalogs: true });
    const inline = capabilities["v0.9"].inlineCatalogs[0];
    expect(inline.components.Text.allOf[1].properties.text).toBeDefined();
    expect(inline.components.Text.allOf[1].required).toContain("text");
    expect(inline.functions.length).toBeGreaterThan(0);
    expect(
      inline.functions.some(
        (fn: { parameters: { properties?: object } }) =>
          Object.keys(fn.parameters.properties ?? {}).length > 0,
      ),
    ).toBe(true);
    processor.processMessages([
      {
        version: "v0.9",
        createSurface: {
          surfaceId: "test",
          catalogId: "synthetic",
        },
      },
    ]);
    processor.processMessages([{ version: "v0.9", deleteSurface: { surfaceId: "test" } }]);
  });
});
