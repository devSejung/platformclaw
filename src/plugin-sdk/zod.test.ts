import { describe, expect, expectTypeOf, it } from "vitest";
import type { Schema, ZodSchema, ZodTypeAny, input, output } from "./zod.js";
import * as sdk from "./zod.js";

describe("supported Zod SDK contract", () => {
  it("retains inference types and the upstream input/output schema helpers", () => {
    expectTypeOf<input<sdk.z.ZodString>>().toEqualTypeOf<string>();
    expectTypeOf<output<sdk.z.ZodString>>().toEqualTypeOf<string>();
    expectTypeOf<Schema>().toEqualTypeOf<sdk.z.ZodType>();
    expectTypeOf<ZodSchema>().toEqualTypeOf<sdk.z.ZodType>();
    expectTypeOf<ZodTypeAny>().toEqualTypeOf<sdk.z.ZodType>();
    for (const name of ["Schema", "ZodSchema", "ZodTypeAny"]) {
      expect(sdk).not.toHaveProperty(name);
    }
    // Main exposes Zod's runtime helpers alongside their existing inference types.
    const codec = sdk.codec(sdk.string(), sdk.number(), { decode: Number, encode: String });
    expect(sdk.input(codec).parse("12")).toBe("12");
    expect(sdk.input(codec).safeParse(12).success).toBe(false);
    expect(sdk.output(codec).parse(12)).toBe(12);
    expect(sdk.output(codec).safeParse("12").success).toBe(false);
  });

  it("exposes the patched schema runtime through the supported facade", () => {
    let visited = 0;
    const schema = sdk
      .array(
        sdk.string().refine(() => {
          visited++;
          return true;
        }),
      )
      .max(2);
    expect(schema.safeParse(Array.from({ length: 100 }, () => "value")).success).toBe(false);
    expect(visited).toBe(0);
  });
});
