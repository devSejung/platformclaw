import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveManagedHtmlPreview } from "./managed-html-preview.js";

const NONCE = "preview-request-123456";

type PreviewShellEvent = {
  source?: unknown;
  data?: unknown;
  ports?: { close: () => void }[];
  effectiveDirective?: string;
};

function inspectPreviewShell(source: string) {
  const { document } = parseHTML(source);
  const scripts = [...document.querySelectorAll("script")];
  expect(scripts).toHaveLength(1);
  const listeners = new Map<string, (event: PreviewShellEvent) => void>();
  const postMessage = vi.fn();
  runInNewContext(scripts[0]!.textContent ?? "", {
    document,
    window: {
      addEventListener: (type: string, callback: (event: PreviewShellEvent) => void) => {
        listeners.set(type, callback);
      },
    },
    parent: { postMessage },
  });
  const frame = document.querySelector("iframe");
  if (!frame) {
    throw new Error("Preview shell did not create its isolated child");
  }
  return { document, frame, childText: frame.srcdoc, listeners, postMessage };
}

describe("managed HTML preview", () => {
  const servers: Server[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function preview(
    source: string | Buffer,
    options: {
      contentType?: string;
      query?: string;
      isEnabled?: () => boolean;
      isStrict?: () => boolean;
      revoke?: boolean;
      method?: string;
    } = {},
  ) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "managed-html-preview-"));
    directories.push(directory);
    const filePath = path.join(directory, "report.html");
    await writeFile(filePath, source);
    const revalidate = vi.fn(async () => !options.revoke);
    const server = createServer((request, response) => {
      void (async () => {
        const handle = await open(filePath, "r");
        await serveManagedHtmlPreview({
          response,
          method: request.method,
          url: new URL(request.url ?? "/", "http://localhost"),
          file: { handle, stat: await handle.stat() },
          contentType: options.contentType ?? "text/html",
          isEnabled: options.isEnabled ?? (() => true),
          isStrict: options.isStrict ?? (() => false),
          revalidate: async () => {
            const authorized = await revalidate();
            if (!authorized) {
              response.statusCode = 404;
              response.end("not found");
            }
            return authorized;
          },
        });
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/?previewNonce=${NONCE}${options.query ?? ""}`,
      { method: options.method ?? "GET" },
    );
    const text = await response.text();
    return {
      response,
      text,
      childText:
        response.headers.get("content-type")?.startsWith("text/html") && options.method !== "HEAD"
          ? inspectPreviewShell(text).childText
          : "",
      revalidate,
      filePath,
    };
  }

  it("isolates authored code and replaces unsupported static assets without changing the source", async () => {
    const source =
      '<!doctype html><html><head><link rel="stylesheet" href="report.css"><script src="app.js"></script><style>body{background:url(secret.png)}</style></head><body><h1>Report</h1><img src="images/chart.png"><img src="data:image/png;base64,AA=="><script>window.reportLoaded=true</script></body></html>';
    const result = await preview(source);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-disposition")).toBe("inline");
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(result.response.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(result.response.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(result.response.headers.get("content-security-policy")).toContain("frame-src about:");
    expect(result.childText).toContain("frame-src 'none'");
    expect(result.childText).toContain("window.reportLoaded=true");
    expect(result.childText).toContain('src="data:image/png;base64,AA=="');
    expect(result.childText).not.toContain("images/chart.png");
    expect(result.childText).not.toContain("report.css");
    expect(result.childText).not.toContain("app.js");
    expect(result.childText).toContain("Some local or external assets cannot be shown");
    expect(result.childText).toContain('"status":"ready"');
    expect(result.childText).toContain('window.addEventListener("load"');
    expect(result.childText).toContain('document.addEventListener("error"');
    expect(result.revalidate).toHaveBeenCalledOnce();
    expect(await readFile(result.filePath, "utf8")).toBe(source);
  });

  it("permits only its server-nonced bootstrap in strict mode", async () => {
    const result = await preview(
      '<button onclick="alert(1)">Report</button><script>alert(2)</script>',
      { query: "&previewMode=strict" },
    );
    const csp = result.response.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/u.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(result.childText).toContain(`<script nonce="${nonce}">`);
    expect(result.childText).toContain(NONCE);
  });

  it("preserves supported chart CSS when omitting individual unavailable declarations", async () => {
    const result = await preview(
      '<style>@import "report.css";.bar{height:100px;width:20px;background:red}body{background-image:url(paper.png);color:navy}@supports(display:grid){.grid{display:grid;background:url("missing;tile.png");gap:1rem}}.modern{--gradient:linear-gradient(red,blue);background:var(--gradient);content:"url(example.png)"}</style><div class="bar" style="height:40px;background-image:url(chart.png);width:12px">Chart</div>',
    );
    const child = parseHTML(result.childText).document;
    const style = child.querySelector("style")?.textContent ?? "";
    expect(style).toContain("height:100px;width:20px;background:red");
    expect(style).toContain("color:navy");
    expect(style).toContain("@supports(display:grid)");
    expect(style).toContain("display:grid;");
    expect(style).toContain("gap:1rem");
    expect(style).toContain("--gradient:linear-gradient(red,blue)");
    expect(style).toContain('content:"url(example.png)"');
    expect(style).not.toContain("report.css");
    expect(style).not.toContain("paper.png");
    expect(style).not.toContain("missing;tile.png");
    expect(child.querySelector(".bar")?.getAttribute("style")).toBe("height:40px;width:12px");
    expect(child.querySelector("[data-openclaw-html-preview-notice]")).not.toBeNull();
  });

  it("reports string-based image-set resources while preserving inline candidates and descriptors", async () => {
    const result = await preview(
      '<style>.chart{height:100px;background-image:image-set("chart.png" 1x);width:20px}.prefixed{background:-webkit-image-set(\'remote.png\' 2x);color:navy}.inline{background-image:image-set("data:image/png;base64,AA==" type("image/png") 1x,url("blob:rendered") 2x);display:grid}.literal{content:"image-set(\\"example.png\\" 1x)"}</style><div style="height:40px;background:image-set(\'tile.png\' 1x);width:12px">Chart</div>',
    );
    const child = parseHTML(result.childText).document;
    const style = child.querySelector("style")?.textContent ?? "";
    expect(style).not.toContain("chart.png");
    expect(style).not.toContain("remote.png");
    expect(style).toContain("height:100px;width:20px");
    expect(style).toContain("color:navy");
    expect(style).toContain('"data:image/png;base64,AA==" type("image/png")');
    expect(style).toContain('url("blob:rendered")');
    expect(style).toContain("display:grid");
    expect(style).toContain("example.png");
    expect(child.querySelector("div")?.getAttribute("style")).toBe("height:40px;width:12px");
    expect(child.querySelector("[data-openclaw-html-preview-notice]")).not.toBeNull();
  });

  it("reports unsupported SVG references and media while retaining local SVG symbols", async () => {
    const result = await preview(
      '<svg><defs><g id="chart"></g></defs><use href="#chart"></use><use href="plot.svg#chart"></use><use xlink:href="other.svg#chart"></use></svg><video controls src="demo.mp4"></video><audio controls><source src="voice.mp3"><track src="captions.vtt"></audio>',
    );
    const child = parseHTML(result.childText).document;
    expect(child.querySelector('use[href="#chart"]')).not.toBeNull();
    expect(result.childText).not.toContain("plot.svg");
    expect(result.childText).not.toContain("other.svg");
    expect(child.querySelector("video, audio, source, track")).toBeNull();
    expect(result.childText).toContain("Media unavailable");
    expect(child.querySelector("[data-openclaw-html-preview-notice]")).not.toBeNull();
  });

  it("pins navigation fragments to srcdoc while retaining local SVG and CSS references", async () => {
    const result = await preview(
      '<a id="toc" href="#details" target="_blank">Details</a><map><area id="area" href="#details" target="_parent"></map><section id="details">Report details</section><style>.filtered{filter:url(#filter)}</style><svg><defs><g id="chart"></g><filter id="filter"><feImage href="#chart"></feImage></filter></defs><a id="svg-link" xlink:href="#details" target="_top"><text>Details</text></a><use href="#chart"></use><image href="#chart"></image></svg>',
    );
    const child = parseHTML(result.childText).document;
    for (const [selector, attribute] of [
      ["#toc", "href"],
      ["#area", "href"],
      ["#svg-link", "xlink:href"],
    ] as const) {
      const link = child.querySelector(selector);
      expect(link?.getAttribute(attribute)).toBe("about:srcdoc#details");
      expect(link?.getAttribute("target")).toBe("_self");
    }
    expect(child.querySelector('use[href="#chart"]')).not.toBeNull();
    expect(child.querySelector('feImage[href="#chart"]')).not.toBeNull();
    expect(child.querySelector("style")?.textContent).toContain("filter:url(#filter)");
    expect(child.querySelector("image")?.hasAttribute("href")).toBe(false);
    expect(child.querySelector("[data-openclaw-html-preview-notice]")).not.toBeNull();
  });

  it("preserves attribute entities through HTML and nested template serialization", async () => {
    const source =
      '<img id="entity-image" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22%3E%3Ctext%3EA &amp;amp; B%3C/text%3E%3C/svg%3E" data-chart="&amp;copy; &amp;#65; &quot;quoted&quot;"><svg data-chart="&amp;copy;"><text>A &amp; B</text></svg><template id="outer-template" data-chart="&amp;copy;"><div data-chart="&amp;#65; &amp;amp;"><template id="inner-template"><span data-chart="&amp;copy; &quot;quoted&quot;">Template</span></template></div></template>';
    const expected = parseHTML(source).document;
    const result = await preview(source);
    const actual = parseHTML(result.childText).document;
    for (const [selector, attribute] of [
      ["#entity-image", "src"],
      ["#entity-image", "data-chart"],
      ["svg", "data-chart"],
      ["#outer-template", "data-chart"],
    ] as const) {
      expect(actual.querySelector(selector)?.getAttribute(attribute)).toBe(
        expected.querySelector(selector)?.getAttribute(attribute),
      );
    }
    const expectedTemplate = expected.querySelector("template")?.content;
    const actualTemplate = actual.querySelector("template")?.content;
    expect(actualTemplate?.querySelector("div")?.getAttribute("data-chart")).toBe(
      expectedTemplate?.querySelector("div")?.getAttribute("data-chart"),
    );
    expect(
      actualTemplate
        ?.querySelector("template")
        ?.content.querySelector("span")
        ?.getAttribute("data-chart"),
    ).toBe(
      expectedTemplate
        ?.querySelector("template")
        ?.content.querySelector("span")
        ?.getAttribute("data-chart"),
    );
    expect(actual.querySelector("svg text")?.textContent).toBe("A & B");
    expect(await readFile(result.filePath, "utf8")).toBe(source);
  });

  it("replaces uninitialized strict images while retaining normal-mode Blob initialization", async () => {
    const source =
      '<img id="generated"><img src=""><img srcset="plot.png 1x"><script>document.getElementById("generated").src=URL.createObjectURL(new Blob([]))</script>';
    const strict = await preview(source, { query: "&previewMode=strict" });
    const strictChild = parseHTML(strict.childText).document;
    expect(strictChild.querySelector("img")).toBeNull();
    expect(strictChild.querySelectorAll('[role="img"]')).toHaveLength(3);
    expect(strictChild.querySelector("[data-openclaw-html-preview-notice]")).not.toBeNull();
    const normal = await preview(source);
    expect(parseHTML(normal.childText).document.querySelector("#generated")).not.toBeNull();
    expect(normal.childText).toContain('for(const image of document.querySelectorAll("img"))');
    expect(normal.childText).toContain('if(!image.getAttribute("src")?.trim())replace(image)');
  });

  it("does not let a query weaken operator strictness, including changes during preparation", async () => {
    for (const activateAfterAwait of [false, true]) {
      let checks = 0;
      const result = await preview("<h1>Report</h1><script>window.authored=true</script>", {
        query: "&previewMode=scripts",
        isStrict: () => !activateAfterAwait || ++checks > 1,
      });
      const csp = result.response.headers.get("content-security-policy") ?? "";
      expect(csp).toMatch(/script-src 'nonce-[^']+'/u);
      expect(csp).not.toContain("script-src 'unsafe-inline'");
      expect(result.childText).toContain("window.authored=true");
    }
  });

  it.each([
    { source: Buffer.from([0xff, 0xfe, 0x00]), status: 422, message: "UTF-8" },
    { source: Buffer.alloc(2 * 1024 * 1024 + 1), status: 413, message: "2 MiB" },
    { source: "plain document", contentType: "text/plain", status: 415, message: "Only HTML" },
  ])(
    "reports an authorized preview input failure ($status)",
    async ({ source, status, message, ...options }) => {
      const result = await preview(source, options);
      expect(result.response.status).toBe(status);
      expect(result.childText).toContain('"status":"error"');
      expect(result.childText).toContain(message);
      expect(result.childText).toContain("Download the original");
    },
  );

  it("honors Canvas disablement after asynchronous preparation", async () => {
    let enabledChecks = 0;
    const result = await preview("<h1>Private report</h1>", {
      isEnabled: () => ++enabledChecks === 1,
    });
    expect(result.response.status).toBe(503);
    expect(result.childText).toContain('"status":"error"');
    expect(result.text).not.toContain("Private report");
  });

  it("does not serve parsed HTML after ownership is revoked", async () => {
    const result = await preview("<h1>Private report</h1>", { revoke: true });
    expect(result.response.status).toBe(404);
    expect(result.text).not.toContain("Private report");
    expect(result.response.headers.get("content-security-policy")).toBeNull();
  });

  it("supports HEAD without exposing a response body", async () => {
    const result = await preview("<h1>Report</h1>", { method: "HEAD" });
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(result.text).toBe("");
  });

  it("keeps script-looking authored content inside the child and forwards only its readiness", async () => {
    const result = await preview(
      '<h1>Report</h1><script>const text="</script><h2>still child</h2><script>";</script>\u2028\u2029',
    );
    const shell = inspectPreviewShell(result.text);
    expect(shell.document.querySelector("h1")).toBeNull();
    expect(shell.document.querySelector("h2")).toBeNull();
    expect(shell.frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(shell.childText).toContain("<h1>Report</h1>");
    const close = vi.fn();
    shell.listeners.get("message")?.({
      source: {},
      data: { type: "openclaw:html-attachment-preview", nonce: NONCE, status: "ready" },
      ports: [{ close }],
    });
    expect(close).toHaveBeenCalledOnce();
    expect(shell.postMessage).not.toHaveBeenCalled();
    shell.listeners.get("message")?.({
      source: shell.frame.contentWindow,
      data: { type: "openclaw:html-attachment-preview", nonce: "another-preview", status: "ready" },
      ports: [],
    });
    expect(shell.postMessage).not.toHaveBeenCalled();
    shell.listeners.get("message")?.({
      source: shell.frame.contentWindow,
      data: {
        type: "openclaw:html-attachment-preview",
        nonce: NONCE,
        status: "ready",
        unexpected: "must not cross",
      },
      ports: [],
    });
    expect(shell.postMessage).toHaveBeenCalledOnce();
    expect(shell.postMessage.mock.calls[0]?.[0]).toMatchObject({
      type: "openclaw:html-attachment-preview",
      nonce: NONCE,
      status: "ready",
    });
    expect(shell.postMessage.mock.calls[0]?.[0]).not.toHaveProperty("unexpected");
  });

  it("reports blocked child navigation once and does not let later readiness hide recovery", async () => {
    const result = await preview("<h1>Report</h1>");
    const shell = inspectPreviewShell(result.text);
    shell.listeners.get("securitypolicyviolation")?.({ effectiveDirective: "img-src" });
    expect(shell.postMessage).not.toHaveBeenCalled();
    shell.listeners.get("securitypolicyviolation")?.({ effectiveDirective: "frame-src" });
    expect(shell.postMessage).toHaveBeenCalledExactlyOnceWith(
      {
        type: "openclaw:html-attachment-preview",
        nonce: NONCE,
        status: "error",
        message:
          "Navigation is unavailable in this isolated preview. Close and reopen the preview, or download the original HTML.",
      },
      "*",
    );
    const close = vi.fn();
    shell.listeners.get("message")?.({
      source: shell.frame.contentWindow,
      data: { type: "openclaw:html-attachment-preview", nonce: NONCE, status: "ready" },
      ports: [{ close }],
    });
    shell.listeners.get("securitypolicyviolation")?.({ effectiveDirective: "frame-src" });
    expect(close).toHaveBeenCalledOnce();
    expect(shell.postMessage).toHaveBeenCalledOnce();
  });
});
