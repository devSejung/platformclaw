import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";

export const PLATFORMCLAW_WEB_LOGIN_PATH = "/platformclaw/login";
export const PLATFORMCLAW_WEB_ASSET_PREFIX = "/platformclaw/assets/";

export type PlatformClawWebAssetHandler = {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
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
  ".webp": "image/webp",
};

const DOCUMENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self' ws: wss:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

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

function collectAssetFiles(root: string, directory: string): Map<string, WebAsset> {
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
      assets.set(`${PLATFORMCLAW_WEB_ASSET_PREFIX}${assetPath}`, {
        filePath,
        contentType: CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      });
    }
  };
  visit(directory, readdirSync(directory, { withFileTypes: true }));
  return assets;
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
}

export function createPlatformClawWebAssetHandler(
  rootDirectory: string,
): PlatformClawWebAssetHandler {
  const root = realpathSync(resolve(rootDirectory));
  const loginFile = assertRegularFileInsideRoot(root, join(root, "platformclaw-login.html"));
  const assetsDirectory = realpathSync(join(root, "assets"));
  if (!assetsDirectory.startsWith(`${root}${sep}`)) {
    throw new Error("PlatformClaw web assets directory escapes root");
  }
  const assets = collectAssetFiles(root, assetsDirectory);

  return {
    async handle(req, res) {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
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
        res.statusCode = 405;
        res.setHeader("Allow", "GET, HEAD");
        res.end("Method Not Allowed");
        return true;
      }

      setSecurityHeaders(res);
      if (isLogin) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Security-Policy", DOCUMENT_SECURITY_POLICY);
      } else if (asset) {
        res.setHeader("Content-Type", asset.contentType);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
      res.statusCode = 200;
      if (req.method === "HEAD") {
        res.end();
        return true;
      }
      res.end(await readFile(filePath));
      return true;
    },
  };
}
