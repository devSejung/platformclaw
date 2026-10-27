import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";

const schemaMaps = new Set([
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
]);
const schemaValues = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

function expandTypeUnions(schema: unknown): void {
  if (!isRecord(schema)) {
    return;
  }
  // Control UI renders primitive anyOf unions; compact type arrays remain form-unsafe.
  if (Array.isArray(schema.type)) {
    const union = { anyOf: schema.type.map((type) => ({ type })) };
    delete schema.type;
    if (schema.anyOf) {
      schema.allOf = [...(Array.isArray(schema.allOf) ? schema.allOf : []), union];
    } else {
      schema.anyOf = union.anyOf;
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (schemaMaps.has(key) && isRecord(value)) {
      Object.values(value).forEach(expandTypeUnions);
    } else if (schemaArrays.has(key) || (key === "items" && Array.isArray(value))) {
      if (Array.isArray(value)) {
        value.forEach(expandTypeUnions);
      }
    } else if (schemaValues.has(key)) {
      expandTypeUnions(value);
    }
  }
}

/** Export config schemas with the validation and form contract shared by all config owners. */
export function configJsonSchema(schema: z.core.$ZodType, io: "input" | "output" = "output") {
  const options = { target: "draft-07", unrepresentable: "any" } as const;
  const result = z.toJSONSchema(schema, {
    ...options,
    io,
    override({ zodSchema, jsonSchema }) {
      const definition: z.core.$ZodTypeDef = z.core.util.cloneDef(zodSchema);
      if (definition.type !== "string" || z.globalRegistry.get(zodSchema)?.format) {
        return;
      }
      // Zod 4.6 labels prefix/regex checks as formats and overwrites URI/email formats.
      // Derive the actual format from its schema check, preserving every pattern constraint.
      delete jsonSchema.format;
      for (const check of [zodSchema, ...(definition.checks ?? [])]) {
        if (check instanceof z.core.$ZodStringFormat) {
          const checkDefinition: z.core.$ZodStringFormatDef = z.core.util.cloneDef(check);
          const isolated = z.core.clone(check, { ...checkDefinition, checks: [] });
          const format = z.toJSONSchema(isolated, options).format;
          if (format) {
            jsonSchema.format = format;
          }
        }
      }
    },
  });
  expandTypeUnions(result);
  return result;
}
