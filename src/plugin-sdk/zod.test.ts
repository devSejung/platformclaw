import { describe, expect, expectTypeOf, it } from "vitest";
import type { Schema, ZodSchema, ZodTypeAny, input, output } from "./zod.js";
import * as sdk from "./zod.js";

describe("supported Zod SDK contract", () => {
  it("keeps schema inference aliases type-only when upstream adds same-named functions", () => {
    expectTypeOf<input<sdk.z.ZodString>>().toEqualTypeOf<string>();
    expectTypeOf<output<sdk.z.ZodString>>().toEqualTypeOf<string>();
    expectTypeOf<Schema>().toEqualTypeOf<sdk.z.ZodType>();
    expectTypeOf<ZodSchema>().toEqualTypeOf<sdk.z.ZodType>();
    expectTypeOf<ZodTypeAny>().toEqualTypeOf<sdk.z.ZodType>();
    for (const name of ["input", "output", "Schema", "ZodSchema", "ZodTypeAny"]) {
      expect(sdk).not.toHaveProperty(name);
    }
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
