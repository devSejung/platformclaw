import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE } from "../../../src/gateway/control-ui-contract.js";

export const PLATFORMCLAW_WEB_LOGIN_PATH = "/platformclaw/login";
export const PLATFORMCLAW_WEB_APP_PATH = "/platformclaw/app";
export const PLATFORMCLAW_WEB_DEFAULT_APP_PATH = `${PLATFORMCLAW_WEB_APP_PATH}/chat`;
export const PLATFORMCLAW_WEB_ASSET_PREFIX = "/platformclaw/assets/";
export const PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME = "platformclaw-web-descriptor";
const PLATFORMCLAW_PRODUCT_NAME = "PlatformClaw";

export const PLATFORMCLAW_WEB_DESCRIPTOR = {
  mode: "platformclaw",
  gatewayPath: "/platformclaw/gateway",
  loginPath: PLATFORMCLAW_WEB_LOGIN_PATH,
  logoutPath: "/platformclaw/api/auth/logout",
  sessionPath: "/platformclaw/api/auth/session",
  vocEnabled: false,
  enabledRoutes: [
    "chat",
    "new-session",
    "activity",
    "sessions",
    "usage",
    "agents",
    "tasks",
    "cron",
    "appearance",
    "credentials",
    "memory",
    "organization",
    "profile",
    "notifications",
    "about",
    "skills",
    "skill-workshop",
    "skill-hub",
    "plugins",
    "mcp",
  ],
} as const;

export type PlatformClawWebAssetHandler = {
  handlePublic(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  handleApplication(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
};

export type PlatformClawWebAssetOptions = {
  publicOrigin: string;
  vocEnabled?: boolean;
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
};

const DOCUMENT_SECURITY_POLICY_BASE = [
  "default-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
];

type WebAsset = {
  filePath: string;
  contentType: string;
  content?: Buffer;
};

function replaceRequiredLiteral(
  source: string,
  expected: string,
  replacement: string,
  label: string,
): string {
  const firstIndex = source.indexOf(expected);
  if (firstIndex < 0 || source.includes(expected, firstIndex + expected.length)) {
    throw new Error(`PlatformClaw Control UI ${label} contract changed`);
  }
  return `${source.slice(0, firstIndex)}${replacement}${source.slice(firstIndex + expected.length)}`;
}

function preparePlatformClawPublicAssets(assets: Map<string, WebAsset>): string {
  const mascotPaths = [...assets.keys()].filter((pathname) =>
    /\/platformclaw-pixel-[^/]+\.svg$/u.test(pathname),
  );
  const mascotPath = mascotPaths[0];
  if (!mascotPath || mascotPaths.length !== 1) {
    throw new Error("PlatformClaw Control UI must contain one canonical mascot asset");
  }
  const manifestPath = `${PLATFORMCLAW_WEB_APP_PATH}/manifest.webmanifest`;
  const manifestAsset = assets.get(manifestPath);
  if (!manifestAsset) {
    throw new Error("PlatformClaw Control UI is missing its web manifest");
  }
  const manifest = JSON.parse(readFileSync(manifestAsset.filePath, "utf8")) as unknown;
  if (!isRecord(manifest)) {
    throw new Error("PlatformClaw Control UI web manifest must be an object");
  }
  manifestAsset.content = Buffer.from(
    `${JSON.stringify({
      ...manifest,
      name: PLATFORMCLAW_PRODUCT_NAME,
      short_name: PLATFORMCLAW_PRODUCT_NAME,
      icons: [{ src: mascotPath, sizes: "any", type: "image/svg+xml", purpose: "any" }],
    })}\n`,
  );

  const serviceWorkerPath = `${PLATFORMCLAW_WEB_APP_PATH}/sw.js`;
  const serviceWorkerAsset = assets.get(serviceWorkerPath);
  if (!serviceWorkerAsset) {
    throw new Error("PlatformClaw Control UI is missing its service worker");
  }
  const serviceWorkerSource = readFileSync(serviceWorkerAsset.filePath, "utf8");
  // Exact literals make upstream drift fail closed instead of serving a mixed
  // brand or caching authenticated PlatformClaw API responses.
  const serviceWorkerReplacements = [
    {
      expected: 'data = { title: "OpenClaw", body: event.data.text() };',
      replacement: `data = { title: ${JSON.stringify(PLATFORMCLAW_PRODUCT_NAME)}, body: event.data.text() };`,
      label: "service worker text-push title",
    },
    {
      expected: 'const title = data.title || "OpenClaw";',
      replacement: `const title = data.title === "OpenClaw" || !data.title ? ${JSON.stringify(PLATFORMCLAW_PRODUCT_NAME)} : data.title;`,
      label: "service worker notification title",
    },
    {
      expected: 'icon: "./apple-touch-icon.png",',
      replacement: `icon: ${JSON.stringify(mascotPath)},`,
      label: "service worker notification icon",
    },
    {
      expected: 'badge: "./favicon-32.png",',
      replacement: `badge: ${JSON.stringify(mascotPath)},`,
      label: "service worker notification badge",
    },
    {
      expected: 'url.pathname.startsWith("/api/") ||',
      replacement:
        'url.pathname.startsWith("/api/") ||\n    url.pathname.startsWith("/platformclaw/api/") ||\n    url.pathname.startsWith("/platformclaw/app/__openclaw__/") ||',
      label: "service worker managed private-route exclusion",
    },
  ] as const;
  let brandedServiceWorker = serviceWorkerSource;
  for (const replacement of serviceWorkerReplacements) {
    brandedServiceWorker = replaceRequiredLiteral(
      brandedServiceWorker,
      replacement.expected,
      replacement.replacement,
      replacement.label,
    );
  }
  serviceWorkerAsset.content = Buffer.from(brandedServiceWorker);
  return mascotPath;
}

function assertRegularFileInsideRoot(root: string, filePath: string): string {
  const resolved = realpathSync(filePath);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`PlatformClaw web asset escapes root: ${filePath}`);
  }
  if (!statSync(resolved).isFile()) {
    throw new Error(`PlatformClaw web asset is not a file: ${filePath}`);
  }
  return resolved;
}

function collectAssetFiles(
  root: string,
  directory: string,
  publicPrefix = PLATFORMCLAW_WEB_ASSET_PREFIX,
): Map<string, WebAsset> {
  const assets = new Map<string, WebAsset>();
  const visit = (current: string, entries: Dirent[]): void => {
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(`PlatformClaw web assets must not contain symlinks: ${entry.name}`);
      }
      const candidate = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(candidate, readdirSync(candidate, { withFileTypes: true }));
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const filePath = assertRegularFileInsideRoot(root, candidate);
      const assetPath = relative(directory, filePath).split(sep).join("/");
      assets.set(`${publicPrefix}${assetPath}`, {
        filePath,
        contentType: CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      });
    }
  };
  visit(directory, readdirSync(directory, { withFileTypes: true }));
  return assets;
}

function collectApplicationPublicFiles(root: string): Map<string, WebAsset> {
  const assets = new Map<string, WebAsset>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "assets" || entry.name.endsWith(".html")) {
      continue;
    }
    const candidate = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`PlatformClaw web assets must not contain symlinks: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      for (const [pathname, asset] of collectAssetFiles(
        root,
        candidate,
        `${PLATFORMCLAW_WEB_APP_PATH}/${entry.name}/`,
      )) {
        assets.set(pathname, asset);
      }
      continue;
    }
    if (entry.isFile()) {
      const filePath = assertRegularFileInsideRoot(root, candidate);
      assets.set(`${PLATFORMCLAW_WEB_APP_PATH}/${entry.name}`, {
        filePath,
        contentType: CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      });
    }
  }
  return assets;
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
}

function documentSecurityPolicy(
  inlineScriptHashes: readonly string[] = [],
  allowSameOriginBase = false,
  websocketOrigin?: string,
  allowWasm = false,
): string {
  const scriptSources = [
    "'self'",
    ...(allowWasm ? ["'wasm-unsafe-eval'"] : []),
    ...inlineScriptHashes.map((hash) => `'sha256-${hash}'`),
  ];
  const connectSources = ["'self'", "data:", ...(websocketOrigin ? [websocketOrigin] : [])];
  return [
    ...DOCUMENT_SECURITY_POLICY_BASE,
    `connect-src ${connectSources.join(" ")}`,
    `base-uri ${allowSameOriginBase ? "'self'" : "'none'"}`,
    `script-src ${scriptSources.join(" ")}`,
  ].join("; ");
}

function resolveWebSocketOrigin(publicOrigin: string): string {
  const url = new URL(publicOrigin);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("PlatformClaw web asset public origin is invalid");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

export function isPlatformClawApplicationPath(pathname: string): boolean {
  return (
    pathname === PLATFORMCLAW_WEB_APP_PATH || pathname.startsWith(`${PLATFORMCLAW_WEB_APP_PATH}/`)
  );
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

type PlatformClawWebDescriptorPayload = Omit<typeof PLATFORMCLAW_WEB_DESCRIPTOR, "vocEnabled"> & {
  readonly vocEnabled: boolean;
};

function prepareApplicationDocument(
  source: string,
  descriptor: PlatformClawWebDescriptorPayload,
  mascotPath: string,
): {
  content: Buffer;
  inlineScriptHashes: string[];
} {
  // Browsers normalize HTML newlines before CSP hashes are checked. Normalize the
  // served document too so Windows-built assets keep the same inline-script hashes.
  const normalizedSource = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const titlePattern = /<title(?:\s[^>]*)?>[\s\S]*?<\/title>/iu;
  if (!titlePattern.test(normalizedSource)) {
    throw new Error("PlatformClaw Control UI document is missing <title>");
  }
  // Brand only shipped bootstrap copy. Upstream comments and technical
  // compatibility text must not turn a harmless sync into a startup failure.
  let brandedSource = normalizedSource
    .replace(titlePattern, `<title>${PLATFORMCLAW_PRODUCT_NAME} Control</title>`)
    .replaceAll("OpenClaw Control UI", `${PLATFORMCLAW_PRODUCT_NAME} Control UI`)
    .replaceAll("different OpenClaw version", `different ${PLATFORMCLAW_PRODUCT_NAME} version`)
    .replaceAll("OpenClaw will retry", `${PLATFORMCLAW_PRODUCT_NAME} will retry`)
    .replaceAll("OpenClaw will keep retrying", `${PLATFORMCLAW_PRODUCT_NAME} will keep retrying`);
  if (/<base\b/i.test(brandedSource)) {
    throw new Error("PlatformClaw Control UI document already contains a base element");
  }
  for (const asset of [
    "favicon.svg",
    "favicon-32.png",
    "apple-touch-icon.png",
    "manifest.webmanifest",
  ] as const) {
    const replacementPath =
      asset === "manifest.webmanifest" ? `${PLATFORMCLAW_WEB_APP_PATH}/${asset}` : mascotPath;
    brandedSource = replaceRequiredLiteral(
      brandedSource,
      `href="./${asset}"`,
      `href="${replacementPath}"`,
      `document ${asset} link`,
    );
  }
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(brandedSource);
  if (!headOpen?.[0] || headOpen.index < 0) {
    throw new Error("PlatformClaw Control UI document is missing <head>");
  }
  const serializedDescriptor = escapeHtmlAttribute(JSON.stringify(descriptor));
  const injection = [
    '<base href="/platformclaw/" />',
    `<meta name="${PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME}" content="${serializedDescriptor}" />`,
  ].join("\n    ");
  // Base must precede every upstream URL-bearing element or the browser may
  // start fetching relative assets against the deep application route.
  const terminalAttributePattern = new RegExp(
    `\\s${CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE}=(?:"[^"]*"|'[^']*')`,
    "i",
  );
  const documentWithTerminal = terminalAttributePattern.test(brandedSource)
    ? brandedSource.replace(
        terminalAttributePattern,
        ` ${CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE}="true"`,
      )
    : brandedSource.replace(/<html\b/i, `<html ${CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE}="true"`);
  const adjustedHeadOpen = /<head(?:\s[^>]*)?>/i.exec(documentWithTerminal);
  const adjustedInjectionIndex =
    (adjustedHeadOpen?.index ?? headOpen.index) +
    (adjustedHeadOpen?.[0].length ?? headOpen[0].length);
  const document = `${documentWithTerminal.slice(0, adjustedInjectionIndex)}\n    ${injection}${documentWithTerminal.slice(adjustedInjectionIndex)}`;
  const inlineScriptHashes = [...document.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/i.test(match[1] ?? ""))
    .map((match) =>
      createHash("sha256")
        .update(match[2] ?? "")
        .digest("base64"),
    );
  return { content: Buffer.from(document), inlineScriptHashes };
}

function methodNotAllowed(res: ServerResponse): void {
  res.statusCode = 405;
  res.setHeader("Allow", "GET, HEAD");
  res.end("Method Not Allowed");
}

export function createPlatformClawWebAssetHandler(
  rootDirectory: string,
  options: PlatformClawWebAssetOptions,
): PlatformClawWebAssetHandler {
  const root = realpathSync(resolve(rootDirectory));
  const loginFile = assertRegularFileInsideRoot(root, join(root, "platformclaw-login.html"));
  const applicationFile = assertRegularFileInsideRoot(root, join(root, "index.html"));
  const websocketOrigin = resolveWebSocketOrigin(options.publicOrigin);
  const assetsDirectory = realpathSync(join(root, "assets"));
  if (!assetsDirectory.startsWith(`${root}${sep}`)) {
    throw new Error("PlatformClaw web assets directory escapes root");
  }
  const assets = collectAssetFiles(root, assetsDirectory);
  for (const [pathname, asset] of collectApplicationPublicFiles(root)) {
    assets.set(pathname, asset);
  }
  const mascotPath = preparePlatformClawPublicAssets(assets);
  const applicationDocument = prepareApplicationDocument(
    readFileSync(applicationFile, "utf8"),
    {
      ...PLATFORMCLAW_WEB_DESCRIPTOR,
      vocEnabled: options.vocEnabled ?? false,
    },
    mascotPath,
  );

  return {
    async handlePublic(req, res) {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
        setSecurityHeaders(res);
        res.setHeader("Location", PLATFORMCLAW_WEB_DEFAULT_APP_PATH);
        res.setHeader("Cache-Control", "no-store");
        res.statusCode = 302;
        res.end();
        return true;
      }
      const isLogin = pathname === PLATFORMCLAW_WEB_LOGIN_PATH;
      const asset = assets.get(pathname);
      if (!isLogin && !asset) {
        return false;
      }
      const filePath = isLogin ? loginFile : asset?.filePath;
      if (!filePath) {
        return false;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res);
        return true;
      }

      setSecurityHeaders(res);
      if (isLogin) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Security-Policy", documentSecurityPolicy([], true));
      } else if (asset) {
        res.setHeader("Content-Type", asset.contentType);
        res.setHeader(
          "Cache-Control",
          pathname.startsWith(PLATFORMCLAW_WEB_ASSET_PREFIX)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      }
      res.statusCode = 200;
      if (req.method === "HEAD") {
        res.end();
        return true;
      }
      res.end(asset?.content ?? (await readFile(filePath)));
      return true;
    },
    async handleApplication(req, res) {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (!isPlatformClawApplicationPath(pathname)) {
        return false;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res);
        return true;
      }
      setSecurityHeaders(res);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Security-Policy",
        documentSecurityPolicy(applicationDocument.inlineScriptHashes, true, websocketOrigin, true),
      );
      res.statusCode = 200;
      res.end(req.method === "HEAD" ? undefined : applicationDocument.content);
      return true;
    },
  };
}
