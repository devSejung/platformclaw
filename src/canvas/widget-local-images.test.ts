import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxFsBridge } from "../agents/sandbox/fs-bridge.js";
import {
  createRemoteShellSandboxFsBridge,
  type RemoteShellSandboxHandle,
} from "../agents/sandbox/remote-fs-bridge.js";
import { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
import { embedWidgetWorkspaceImages } from "./widget-local-images.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createWorkspace() {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "openclaw-widget-images-")));
  tempDirs.push(temp);
  const root = path.join(temp, "gateway-workspace");
  await mkdir(root);
  const sandbox = createSandboxTestContext({
    overrides: { workspaceDir: root, agentWorkspaceDir: root },
  });
  return { temp, root, sandbox };
}

async function writeNestedWidget(root: string) {
  const directory = path.join(root, "site", "pages");
  await mkdir(path.join(root, "site", "images"), { recursive: true });
  await mkdir(path.join(directory, "~"), { recursive: true });
  const widgetCode = '<img src="../images/pixel.png?cache=1#image"><img src="~/pixel.png">';
  const source = path.join(directory, "page.html");
  await writeFile(source, widgetCode);
  await writeFile(path.join(root, "site", "images", "pixel.png"), PNG);
  await writeFile(path.join(directory, "~", "pixel.png"), PNG);
  return { source, widgetCode };
}

describe("widget images through the Basic workspace filesystem bridge", () => {
  it("preserves attribute and SVG data URL entities while embedding a workspace PNG", async () => {
    const { root, sandbox } = await createWorkspace();
    const svgUrl =
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><text>A&amp;B</text></svg>';
    const widgetCode = [
      '<main data-chart="&amp;copy;" data-number="&amp;#169;">',
      '<img data-local src="pixel.png">',
      `<img data-svg src="${svgUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`,
      '<script>const label = "&copy;";</script>',
      "</main>",
    ].join("");
    const source = path.join(root, "report.html");
    await writeFile(source, widgetCode);
    await writeFile(path.join(root, "pixel.png"), PNG);
    const result = await embedWidgetWorkspaceImages({
      widgetCode,
      widgetPath: "/workspace/report.html",
      workspace: { root, bridge: createSandboxFsBridge({ sandbox }) },
    });

    // Parsing the hosted bytes repeats the browser's attribute decoding boundary.
    // The PNG rewrite must not make unrelated literal entities decode a second time.
    const { document } = parseHTML(result);
    expect(document.querySelector("[data-local]")?.getAttribute("src")).toBe(DATA_URL);
    expect(document.querySelector("[data-svg]")?.getAttribute("src")).toBe(svgUrl);
    expect(document.querySelector("main")?.getAttribute("data-chart")).toBe("&copy;");
    expect(document.querySelector("main")?.getAttribute("data-number")).toBe("&#169;");
    expect(document.querySelector("script")?.textContent).toBe('const label = "&copy;";');
    expect(await readFile(source, "utf8")).toBe(widgetCode);
  });

  it.each(["host", "container", "relative"] as const)(
    "embeds nested image URLs from a %s source path",
    async (kind) => {
      const { root, sandbox } = await createWorkspace();
      const { source, widgetCode } = await writeNestedWidget(root);
      const widgetPath =
        kind === "host"
          ? source
          : kind === "container"
            ? "/workspace/site/pages/page.html"
            : "site/pages/page.html";
      const result = await embedWidgetWorkspaceImages({
        widgetCode,
        widgetPath,
        workspace: { root, bridge: createSandboxFsBridge({ sandbox }) },
      });
      expect(result.match(/src="data:image\/png;base64,/gu)).toHaveLength(2);
      expect(result).toContain(DATA_URL);
    },
  );
});

const runRemoteShellScript: RemoteShellSandboxHandle["runRemoteShellScript"] = async (command) => {
  // Run the production remote bridge's shell and pinned Python guards locally;
  // the separate SSH/browser proof covers the transport and authenticated relay.
  const result = spawnSync(
    "sh",
    ["-c", command.script, "widget-filesystem", ...(command.args ?? [])],
    { input: command.stdin, maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
  );
  if (result.error) {
    throw result.error;
  }
  const code = result.status ?? 1;
  if (code !== 0 && !command.allowFailure) {
    throw new Error(result.stderr.toString("utf8").trim() || `remote shell exited ${code}`);
  }
  return { stdout: result.stdout, stderr: result.stderr, code };
};

async function createRemoteWorkspace() {
  const { temp, root, sandbox } = await createWorkspace();
  const home = path.join(temp, "home");
  const remoteWorkspace = path.join(home, ".platformclaw", "workspace");
  await mkdir(remoteWorkspace, { recursive: true });
  const bridge = createRemoteShellSandboxFsBridge({
    sandbox,
    runtime: {
      remoteWorkspaceDir: remoteWorkspace,
      remoteAgentWorkspaceDir: remoteWorkspace,
      remoteHomeDir: home,
      additionalFilesystemRoots: [{ root: home, access: "rw" }],
      runRemoteShellScript,
    },
  });
  return { temp, home, remoteWorkspace, workspace: { root, bridge } };
}

describe.runIf(process.platform !== "win32")(
  "widget images through the remote filesystem bridge",
  () => {
    it.each(["home", "absolute", "relative"] as const)(
      "resolves a %s source once and preserves literal tilde image URLs",
      async (kind) => {
        const { home, remoteWorkspace, workspace } = await createRemoteWorkspace();
        const sourceRoot = kind === "relative" ? remoteWorkspace : home;
        const { source, widgetCode } = await writeNestedWidget(sourceRoot);
        // Expanding an image URL as a model-facing HOME alias would read this
        // invalid decoy instead of the source document's literal ~/ directory.
        await writeFile(path.join(home, "pixel.png"), "not an image");
        const widgetPath =
          kind === "home"
            ? "~/site/pages/page.html"
            : kind === "absolute"
              ? source
              : "site/pages/page.html";
        const result = await embedWidgetWorkspaceImages({ widgetCode, widgetPath, workspace });
        expect(result.match(/src="data:image\/png;base64,/gu)).toHaveLength(2);
        expect(result).toContain(DATA_URL);
      },
    );

    it("rejects stale source bytes after resolving a home alias without image references", async () => {
      const { home, workspace } = await createRemoteWorkspace();
      await writeFile(path.join(home, "page.html"), "<p>saved source</p>");
      await expect(
        embedWidgetWorkspaceImages({
          widgetCode: "<p>different source</p>",
          widgetPath: "~/page.html",
          workspace,
        }),
      ).rejects.toThrow("must exactly match widget_code");
    });

    it.each([
      { kind: "outside", target: "source" },
      { kind: "outside", target: "image" },
      { kind: "symlink", target: "source" },
      { kind: "symlink", target: "image" },
      { kind: "hardlink", target: "source" },
      { kind: "hardlink", target: "image" },
      { kind: "oversized", target: "source" },
      { kind: "oversized", target: "image" },
    ] as const)("keeps the $kind guard for a normalized $target", async ({ kind, target }) => {
      const { temp, home, workspace } = await createRemoteWorkspace();
      let source = path.join(home, "page.html");
      let image = path.join(home, "pixel.png");
      if (kind === "outside") {
        if (target === "source") {
          source = path.join(temp, "outside.html");
        } else {
          image = path.join(temp, "outside.png");
        }
      }
      const widgetCode = `<img src="${image}">`;
      await writeFile(source, widgetCode);
      await writeFile(image, PNG);
      const guarded = target === "source" ? source : image;
      if (kind === "symlink" || kind === "hardlink") {
        const alias = `${guarded}.alias`;
        if (kind === "symlink") {
          await symlink(guarded, alias);
        } else {
          await link(guarded, alias);
        }
        if (target === "source") {
          source = alias;
        } else {
          image = alias;
          await writeFile(source, `<img src="${image}">`);
        }
      }
      if (kind === "oversized") {
        await writeFile(guarded, Buffer.alloc((target === "source" ? 6 : 2) * 1024 * 1024 + 1));
      }
      const failure = {
        outside: /escapes allowed mounts/iu,
        symlink: /symbolic link|symlink/iu,
        hardlink: /hardlinked file/iu,
        oversized: /exceeds bounded read limit/iu,
      }[kind];
      await expect(
        embedWidgetWorkspaceImages({
          widgetCode: `<img src="${image}">`,
          widgetPath: source.startsWith(`${home}/`) ? `~/${path.relative(home, source)}` : source,
          workspace,
        }),
      ).rejects.toThrow(failure);
    });
  },
);
