import { describe, expect, it } from "vitest";
import { z } from "zod";
import { analyzeConfigSchema } from "../../ui/src/components/config-form.analyze.js";
import { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
import { buildPluginConfigSchema } from "../plugins/config-schema.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { configJsonSchema } from "./config-json-schema.js";

function validates(
  schema: Parameters<typeof validateJsonSchemaValue>[0]["schema"] | undefined,
  value: unknown,
): boolean {
  if (!schema) {
    throw new Error("expected exported JSON Schema");
  }
  return validateJsonSchemaValue({
    schema,
    value,
    cacheKey: "config-json-schema.test",
    cache: false,
  }).ok;
}

describe("config JSON Schema export", () => {
  it("keeps channel and plugin primitive unions editable in Control UI", () => {
    const schema = z.object({ allowFrom: z.array(z.union([z.string(), z.number()])) });
    const channel = buildChannelConfigSchema(schema).schema;
    const plugin = buildPluginConfigSchema(schema).jsonSchema;
    for (const exported of [channel, plugin]) {
      expect(analyzeConfigSchema(exported).unsupportedPaths).toEqual([]);
      for (const value of [{ allowFrom: ["alice", 42] }, { allowFrom: [true] }]) {
        expect(validates(exported, value)).toBe(schema.safeParse(value).success);
      }
    }
  });

  it.each([
    ["embedded", z.string().url().startsWith("https://")],
    ["direct", z.url().startsWith("https://")],
    ["pattern", z.url().regex(/^https:\/\//)],
  ])("retains URL validation with a %s format and additional checks", (_, url) => {
    const source = z.object({ url });
    for (const exported of [
      buildChannelConfigSchema(source).schema,
      buildPluginConfigSchema(source).jsonSchema,
    ]) {
      for (const value of [
        "https://example.com/path",
        "https://",
        "https:// bad",
        "http://example.com",
      ]) {
        const input = { url: value };
        expect(validates(exported, input)).toBe(source.safeParse(input).success);
      }
    }
  });

  it("preserves metadata and format checks without treating prefix checks as formats", () => {
    const source = z.object({
      email: z.email().regex(/example/),
      prefix: z.string().startsWith("abc"),
      custom: z.string().meta({ format: "custom" }),
      local: z.iso.datetime({ local: true }),
    });
    expect(configJsonSchema(source)).toMatchObject({
      properties: {
        email: { format: "email" },
        prefix: { pattern: "^abc.*" },
        custom: { format: "custom" },
      },
    });
    expect(configJsonSchema(source).properties?.prefix).not.toHaveProperty("format");
    expect(configJsonSchema(source).properties?.local).not.toHaveProperty("format");
  });

  it("keeps schema-shaped defaults and examples unchanged", () => {
    const value = { type: ["string", "number"], anyOf: [{ type: "string" }] };
    const schema = z.object({
      payload: z
        .unknown()
        .default(value)
        .meta({ examples: [value] }),
    });
    const exported = configJsonSchema(schema);
    expect(exported).toMatchObject({
      properties: { payload: { default: value, examples: [value] } },
    });
  });

  it("preserves sibling union constraints and schema definitions", () => {
    const source = z.union([z.string(), z.number()]).meta({
      anyOf: [{ const: "allowed" }],
      definitions: { nested: { type: ["string", "number"] } },
    });
    const exported = configJsonSchema(source);
    expect(exported).toMatchObject({
      definitions: {
        nested: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
    });
    for (const value of ["allowed", "other", 42, true]) {
      expect(validates(exported, value)).toBe(value === "allowed");
    }
  });
});
