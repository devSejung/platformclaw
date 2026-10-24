// Prove the security backports through installed runtime artifacts, outside Vitest's module transform.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const probeSource = `import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import path from "node:path";
const require = createRequire(import.meta.url);
const sdkRoot = path.dirname(require.resolve("@discord/embedded-app-sdk/package.json"));
const zodRoot = path.dirname(createRequire(\`\${sdkRoot}/package.json\`).resolve("zod/package.json"));
const zod4Root = path.dirname(require.resolve("zod/package.json"));
const canvasRoot = path.dirname(createRequire(require.resolve("@a2ui/web_core")).resolve("zod/package.json"));
const canvasLitRoot = path.dirname(createRequire(require.resolve("@a2ui/lit")).resolve("zod/package.json"));
const entries = [
  ["a2ui-core-v3-esm", \`\${canvasRoot}/index.js\`, "v3"],
  ["a2ui-core-v3-cjs", \`\${canvasRoot}/index.cjs\`, "v3"],
  ["a2ui-lit-v3-esm", \`\${canvasLitRoot}/index.js\`, "v3"],
  ["a2ui-lit-v3-cjs", \`\${canvasLitRoot}/index.cjs\`, "v3"],
  ["root-v4-v3-esm", \`\${zod4Root}/v3/index.js\`, "v3"],
  ["root-v4-v3-cjs", \`\${zod4Root}/v3/index.cjs\`, "v3"],
  ["v3-root-esm", \`\${zodRoot}/index.js\`, "v3"],
  ["v3-root-cjs", \`\${zodRoot}/index.cjs\`, "v3"],
  ["v3-explicit-esm", \`\${zodRoot}/v3/index.js\`, "v3"],
  ["v3-explicit-cjs", \`\${zodRoot}/v3/index.cjs\`, "v3"],
  ["discord-v3-esm", \`\${sdkRoot}/output/lib/zod/lib/index.mjs\`, "v3"],
  ["discord-v3-cjs", \`\${sdkRoot}/output/lib/zod/lib/index.cjs\`, "v3"],
  ["embedded-v4-classic-esm", \`\${zodRoot}/v4/index.js\`, "v4"],
  ["embedded-v4-classic-cjs", \`\${zodRoot}/v4/index.cjs\`, "v4"],
  ["embedded-v4-mini-esm", \`\${zodRoot}/v4/mini/index.js\`, "mini"],
  ["embedded-v4-mini-cjs", \`\${zodRoot}/v4/mini/index.cjs\`, "mini"],
  ["embedded-v4-mini-alias-esm", \`\${zodRoot}/v4-mini/index.js\`, "mini"],
  ["embedded-v4-mini-alias-cjs", \`\${zodRoot}/v4-mini/index.cjs\`, "mini"],
  ["embedded-v4-core-esm", \`\${zodRoot}/v4/core/index.js\`, "core"],
  ["embedded-v4-core-cjs", \`\${zodRoot}/v4/core/index.cjs\`, "core"],
];
const load = async (file) => file.endsWith(".cjs") ? require(file) : import(pathToFileURL(file).href);
const failures = [];
let passed = 0;

async function check(label, body) {
  try { await body(); passed += 1; }
  catch (error) { failures.push({ label, error: error.message }); }
}

for (const [name, file, kind] of entries) {
  const mod = await load(file);
  const z = mod.z ?? mod;
  const core = kind === "v3" ? null : await load(\`\${zodRoot}/v4/core/index.\${file.endsWith(".cjs") ? "cjs" : "js"}\`);
  const string = () => kind === "core" ? new core.$ZodString({ type: "string" }) : z.string();
  const parse = (schema, value, async = false) => kind === "v3"
    ? async ? schema.safeParseAsync(value) : schema.safeParse(value)
    : async ? core.safeParseAsync(schema, value) : core.safeParse(schema, value);
  const bound = (shape, element, count) => {
    if (kind === "v3") return shape === "array-length" ? z.array(element).length(count, "bounded")
      : shape === "array-max" ? z.array(element).max(count, "bounded")
      : shape === "set-size" ? z.set(element).size(count, "bounded")
      : z.set(element).max(count, "bounded");
    const type = shape.startsWith("array") ? "array" : shape.startsWith("set") ? "set" : "map";
    const schema = kind === "core" ? type === "array"
      ? new core.$ZodArray({ type, element }) : type === "set"
        ? new core.$ZodSet({ type, valueType: element })
        : new core.$ZodMap({ type, keyType: element, valueType: element })
      : type === "array" ? z.array(element) : type === "set" ? z.set(element) : z.map(element, element);
    const check = shape === "array-length" ? core._length(count, { error: "bounded" })
      : shape === "array-max" ? core._maxLength(count, { error: "bounded" })
      : shape === "set-size" ? core._size(count, { error: "bounded" })
      : core._maxSize(count, { error: "bounded" });
    return kind === "core" ? new schema.constructor({ ...schema._zod.def, checks: [check] }) : schema.check(check);
  };
  const shapes = ["array-max", "array-length", "set-max", "set-size", ...(kind === "v3" ? [] : ["map-max"])];
  for (const shape of shapes) {
    for (const async of [false, true]) {
      await check(\`\${name}/\${shape}/\${async ? "async" : "sync"}\`, async () => {
        let visited = 0;
        const rejectsChild = () => { visited += 1; return false; };
        const element = kind === "core"
          ? new core.$ZodCustom({ type: "custom", check: "custom", fn: rejectsChild })
          : z.custom(rejectsChild);
        const values = Array.from({ length: 128 }, (_, index) => index);
        const value = shape.startsWith("array") ? values : shape.startsWith("set") ? new Set(values) : new Map(values.map((value) => [value, value]));
        const result = await parse(bound(shape, element, 2), value, async);
        assert.equal(result.success, false);
        assert.equal(visited, 0, "oversized collection must not parse children");
        assert.equal(result.error.issues.length, 1, "bounded one size issue");
        assert.equal(result.error.issues[0].code, "too_big");
        assert.equal(result.error.issues[0].message, "bounded");
      });
    }
  }
  await check(\`\${name}/valid-boundary-and-wrong-type\`, async () => {
    const schema = bound("array-max", string(), 2);
    const result = await parse(schema, ["a", "b"]);
    assert.equal(result.success, true);
    assert.deepEqual(result.data, ["a", "b"]);
    const wrong = await parse(schema, new Set(["a", "b", "c"]));
    assert.equal(wrong.success, false);
    assert.equal(wrong.error.issues[0].code, "invalid_type");
  });
  if (kind === "v3") {
    await check(\`\${name}/minimum-and-effects\`, async () => {
      let refined = 0;
      let child = 0;
      const element = z.string().refine(() => { child += 1; return true; });
      const tooBig = z.array(element).max(2).refine(() => { refined += 1; return true; });
      assert.equal((await tooBig.safeParseAsync(["a", "b", "c"])).success, false);
      assert.deepEqual([child, refined], [0, 0]);
      const tooSmall = z.array(z.string()).min(2).refine(() => { refined += 1; return true; });
      const result = tooSmall.safeParse(["a"]);
      assert.equal(result.error.issues[0].code, "too_small");
      assert.equal(refined, 1, "undersized dirty refinement behavior stays intact");
      const transformed = z.preprocess((items) => items.slice(0, 2), z.array(z.string()).max(2));
      assert.deepEqual(transformed.parse(["a", "b", "c"]), ["a", "b"]);
      assert.equal(typeof z.map(z.string(), z.string()).max, "undefined", "v3 Map has no size bound API");
      assert.equal(z.map(z.string(), z.string()).parse(new Map([["a", "b"]])).get("a"), "b");
      let asyncChildren = 0;
      const asyncSchema = z.array(z.string().refine(async () => { asyncChildren += 1; return true; })).max(1);
      assert.equal((await asyncSchema.safeParseAsync(["a", "b"])).success, false);
      assert.equal(asyncChildren, 0);
    });
  }
  if (kind === "v4") {
    await check(\`\${name}/ordering-minimum-and-refinement\`, async () => {
      let child = 0;
      let refined = 0;
      const element = z.string().refine(() => { child += 1; return true; });
      const schema = z.array(element).max(1).refine(() => { refined += 1; return true; });
      assert.equal((await schema.safeParseAsync(["a", "b"])).success, false);
      assert.deepEqual([child, refined], [0, 0]);
      assert.deepEqual(z.array(z.string()).overwrite((items) => items.slice(0, 1)).max(1).parse(["a", "b"]), ["a"]);
      assert.equal(z.array(z.string()).min(2).safeParse(["a"]).error.issues[0].code, "too_small");
      const conditional = core._maxLength(1);
      conditional._zod.def.when = () => false;
      assert.equal(z.array(z.string()).check(conditional).safeParse(["a", "b"]).success, true);
      const nested = z.object({ items: z.array(z.string()).max(1) }).safeParse({ items: [1, 2] });
      assert.deepEqual(nested.error.issues[0].path, ["items"]);
      assert.equal(nested.error.issues.length, 1);
    });
  }
}
// Exercise the actual MCP adapter that constructs and parses v3 schemas.
const mcp = await load(require.resolve("@modelcontextprotocol/sdk/server/zod-compat.js"));
const z3 = await load(\`\${zod4Root}/v3/index.cjs\`);
for (const async of [false, true]) {
  await check(\`mcp-v3-adapter/\${async ? "async" : "sync"}\`, async () => {
    let visited = 0;
    const items = z3.array(z3.custom(() => { visited += 1; return false; })).max(2);
    const schema = mcp.objectFromShape({ items });
    const input = { items: Array(128).fill(null) };
    const result = async ? await mcp.safeParseAsync(schema, input) : mcp.safeParse(schema, input);
    assert.equal(result.success, false);
    assert.equal(visited, 0);
    assert.equal(result.error.issues.length, 1);
    assert.deepEqual(result.error.issues[0].path, ["items"]);
  });
}
console.log(JSON.stringify({ entries: entries.length, passed, failed: failures.length, failures }));
process.exitCode = failures.length ? 1 : 0;
`;

it("bounds collection work in every patched Zod, Canvas, Discord, and MCP runtime entry", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probeSource], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const summary = JSON.parse(result.stdout);
  expect(summary).toMatchObject({ entries: 20, failed: 0, failures: [] });
  expect(summary.passed).toBeGreaterThan(170);
});
