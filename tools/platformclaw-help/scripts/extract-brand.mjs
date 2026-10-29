import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const product = path.resolve(root, "../..");
const paths = [
  "ui/src/platformclaw/platformclaw-pixel.svg",
  "ui/src/styles/platformclaw-theme.css",
  "ui/src/pages/chat/components/chat-message.ts",
  "ui/src/pages/chat/components/chat-message-group.ts",
  "ui/src/pages/chat/components/chat-composer.ts",
  "ui/src/pages/skill-hub/page-support.ts",
  "ui/src/pages/agents/memory/wiki-graph.runtime.ts",
  "ui/src/pages/agents/memory/view.ts",
  "ui/src/platformclaw/spaces-view.ts",
  "ui/src/pages/cron/view.ts",
  "ui/src/pages/skill-workshop/view.ts",
  "ui/src/platformclaw/exec-credentials-view.ts",
  "ui/src/components/terminal/terminal-panel-chrome.ts",
  "ui/src/components/terminal/terminal-panel-tabs.ts",
  "ui/src/platformclaw/execution-settings-shell.ts",
  "ui/src/platformclaw/execution-location-view.ts",
  "ui/src/platformclaw/locales/ko-execution.ts",
  "ui/src/pages/skill-hub/workspace-publish-controller.ts",
  "ui/src/pages/skill-hub/install-controller.ts",
  "ui/src/pages/skill-workshop/self-learning.ts",
  "ui/src/platformclaw/memory-vault-graph.ts",
  "ui/src/platformclaw/credential-flow.ts",
  "src/agents/system-prompt.ts",
];
const sources = {};
for (const file of paths)
  sources[file] = createHash("sha256")
    .update(await fs.readFile(path.join(product, file)))
    .digest("hex");
const css = await fs.readFile(path.join(product, paths[1]), "utf8");
const light = css.match(/:root\[data-theme="platformclaw-light"\]\s*\{([^}]+)\}/s)?.[1];
if (!light) throw Error("Actual PlatformClaw light theme missing");
const tokens = Object.fromEntries(
  [...light.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
);
if (tokens["--accent"] !== "#0f7c72") throw Error("Review changed product brand before rebuilding");
await fs.mkdir(path.join(root, "public/brand"), { recursive: true });
await fs.copyFile(
  path.join(product, paths[0]),
  path.join(root, "public/brand/platformclaw-mascot.svg"),
);
const manifest = {
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: product,
    encoding: "utf8",
  }).trim(),
  theme: "platformclaw-light",
  architecture: "native-remotion-fragments",
  sources,
  tokens,
};
await fs.writeFile(
  path.join(root, "src/product-brand.generated.json"),
  JSON.stringify(manifest, null, 2),
);
await fs.writeFile(
  path.join(root, "public/brand/manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(
  "Canonical PlatformClaw mascot and light-theme tokens extracted. No full product runtime.",
);
