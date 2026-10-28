// @vitest-environment node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

it("keeps UI modules, custom elements, storage, mocks, and File/FormData bytes in one DOM realm", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-realm-")));
  try {
    await fs.symlink(
      path.join(repoRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    const write = (name: string, source: string) => fs.writeFile(path.join(root, name), source);
    const elementModule = JSON.stringify(path.join(repoRoot, "ui/src/lit/openclaw-element.ts"));
    await write(
      "component.ts",
      [
        `import { OpenClawLightDomContentsElement } from ${elementModule};`,
        "export class ProbeElement extends OpenClawLightDomContentsElement {}",
        "customElements.define('openclaw-ui-realm-probe', ProbeElement);",
      ].join("\n"),
    );
    await write("dep.ts", "export const value = 'real';\n");
    await write(
      "consumer.ts",
      "import { value } from './dep.ts'; export const readValue = () => value;\n",
    );
    for (const [file, value] of [
      ["a", "first"],
      ["b", "second"],
    ] as const) {
      await write(
        `${file}.test.ts`,
        [
          "import { expect, it, vi } from 'vitest';",
          `import { OpenClawLightDomContentsElement } from ${elementModule};`,
          "import { ProbeElement } from './component.ts';",
          `vi.mock('./dep.ts', () => ({ value: ${JSON.stringify(value)} }));`,
          "import { readValue } from './consumer.ts';",
          "it('uses its own DOM constructors, state, mock, and File/FormData bytes', async () => {",
          "  const element = document.createElement('openclaw-ui-realm-probe');",
          "  expect(element.constructor).toBe(ProbeElement);",
          "  expect(element).toBeInstanceOf(OpenClawLightDomContentsElement);",
          "  expect(document.querySelector('#prior-file')).toBeNull();",
          "  expect(localStorage.getItem('prior-file')).toBeNull();",
          "  expect(globalThis.priorFile).toBeUndefined();",
          `  expect(readValue()).toBe(${JSON.stringify(value)});`,
          "  const bytes = new Uint8Array([0, 1, 128, 255]);",
          "  const archive = new File([bytes], 'skill.zip', { type: 'application/zip' });",
          "  expect([...new Uint8Array(await archive.arrayBuffer())]).toEqual([...bytes]);",
          "  const form = new FormData(); form.append('archive', archive);",
          "  const parsed = form.get('archive');",
          "  if (!parsed || typeof parsed === 'string') throw new Error('Missing archive');",
          "  expect(parsed).toBeInstanceOf(File);",
          "  expect([...new Uint8Array(await parsed.arrayBuffer())]).toEqual([...bytes]);",
          "  document.body.innerHTML = '<div id=prior-file></div>';",
          "  localStorage.setItem('prior-file', 'owned');",
          "  vi.stubGlobal('priorFile', 'owned');",
          "});",
        ].join("\n"),
      );
    }
    const configPath = path.join(root, "vitest.config.ts");
    await write(
      "vitest.config.ts",
      [
        `import { createUiVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.ui.config.ts"))};`,
        "const config = createUiVitestConfig(process.env);",
        "export default {",
        "  ...config,",
        `  root: ${JSON.stringify(root)},`,
        `  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},`,
        `  server: { fs: { allow: ${JSON.stringify([root, repoRoot])} } },`,
        "  test: {",
        "    ...config.test,",
        `    dir: ${JSON.stringify(root)},`,
        "    include: ['*.test.ts'],",
        "    fileParallelism: false,",
        "    maxWorkers: 1,",
        "  },",
        "};",
      ].join("\n"),
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("VITEST") &&
          !key.startsWith("OPENCLAW_VITEST") &&
          key !== "GITHUB_ACTIONS",
      ),
    );
    Object.assign(env, {
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      OPENCLAW_TEST_HOME: path.join(root, "home"),
      OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(root, "module-cache"),
      NODE_OPTIONS: "",
      NO_COLOR: "1",
    });
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [path.join(repoRoot, "scripts/run-vitest.mjs"), "run", "--config", configPath],
      { cwd: repoRoot, env, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(`${stdout}\n${stderr}`).toContain("2 passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
