import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE } from "../../../src/gateway/control-ui-contract.js";

export const PLATFORMCLAW_WEB_LOGIN_PATH = "/platformclaw/login";
export const PLATFORMCLAW_WEB_APP_PATH = "/platformclaw/app";
export const PLATFORMCLAW_WEB_DEFAULT_APP_PATH = `${PLATFORMCLAW_WEB_APP_PATH}/chat`;
export const PLATFORMCLAW_WEB_ASSET_PREFIX = "/platformclaw/assets/";
export const PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME = "platformclaw-web-descriptor";

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
};

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
): {
  content: Buffer;
  inlineScriptHashes: string[];
} {
  // Browsers normalize HTML newlines before CSP hashes are checked. Normalize the
  // served document too so Windows-built assets keep the same inline-script hashes.
  const normalizedSource = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (/<base\b/i.test(normalizedSource)) {
    throw new Error("PlatformClaw Control UI document already contains a base element");
  }
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(normalizedSource);
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
  const documentWithTerminal = terminalAttributePattern.test(normalizedSource)
    ? normalizedSource.replace(
        terminalAttributePattern,
        ` ${CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE}="true"`,
      )
    : normalizedSource.replace(/<html\b/i, `<html ${CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE}="true"`);
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
  const applicationDocument = prepareApplicationDocument(readFileSync(applicationFile, "utf8"), {
    ...PLATFORMCLAW_WEB_DESCRIPTOR,
    vocEnabled: options.vocEnabled ?? false,
  });
  const websocketOrigin = resolveWebSocketOrigin(options.publicOrigin);
  const assetsDirectory = realpathSync(join(root, "assets"));
  if (!assetsDirectory.startsWith(`${root}${sep}`)) {
    throw new Error("PlatformClaw web assets directory escapes root");
  }
  const assets = collectAssetFiles(root, assetsDirectory);
  for (const [pathname, asset] of collectApplicationPublicFiles(root)) {
    assets.set(pathname, asset);
  }

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
      res.end(await readFile(filePath));
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
