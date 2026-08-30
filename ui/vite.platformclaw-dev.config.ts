import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ProxyOptions, UserConfig } from "vite";
import { defineConfig, loadEnv } from "vite";
import {
  PLATFORMCLAW_WEB_DESCRIPTOR,
  PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME,
} from "./src/platformclaw/web-contract.ts";
import controlUiViteConfig from "./vite.config.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PLATFORMCLAW_BACKEND_ORIGIN = "http://127.0.0.1:19001";
const PLATFORMCLAW_DEV_PROXY_PATHS = [
  "/platformclaw/api",
  "/platformclaw/gateway",
  "/platformclaw/health",
  "/employee",
] as const;

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function resolveHttpOrigin(
  value: string | undefined,
  variableName: string,
  fallback: string,
): string {
  const raw = value?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new Error(`${variableName} must be an HTTP(S) origin: ${raw}`, {
      cause: error,
    });
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${variableName} must be an HTTP(S) origin: ${raw}`);
  }
  return parsed.origin;
}

export function resolvePlatformClawDevBackendOrigin(
  value = process.env.PLATFORMCLAW_DEV_BACKEND_URL,
): string {
  return resolveHttpOrigin(
    value,
    "PLATFORMCLAW_DEV_BACKEND_URL",
    DEFAULT_PLATFORMCLAW_BACKEND_ORIGIN,
  );
}

export function resolvePlatformClawDevRequestOrigin(
  backendOrigin: string,
  value = process.env.PLATFORMCLAW_DEV_REQUEST_ORIGIN,
): string {
  return resolveHttpOrigin(value, "PLATFORMCLAW_DEV_REQUEST_ORIGIN", backendOrigin);
}

function platformClawDescriptorPlugin(): Plugin {
  const descriptor = `<meta name="${PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME}" content="${escapeHtmlAttribute(
    JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR),
  )}" />`;
  return {
    name: "platformclaw-dev-descriptor",
    transformIndexHtml(html) {
      const existing = new RegExp(
        `<meta\\s+name=["']${PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME}["'][^>]*>`,
        "i",
      );
      if (existing.test(html)) {
        return html.replace(existing, descriptor);
      }
      return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}\n    ${descriptor}`);
    },
  };
}

function platformClawBootstrapConfigPlugin(): Plugin {
  return {
    name: "platformclaw-dev-bootstrap-config",
    configureServer(server) {
      // PlatformClaw routes infer /platformclaw as the UI base path, while
      // the shared app config contract remains rooted at /control-ui-config.json.
      server.middlewares.use("/platformclaw/control-ui-config.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            basePath: "/",
            assistantName: "",
            assistantAvatar: "",
          }),
        );
      });
    },
  };
}

function setBackendOrigin(
  request: { setHeader(name: string, value: string): void },
  origin: string,
) {
  // The control plane validates browser Origin for mutations and WebSockets.
  // Forward the configured public origin while preserving browser cookies on
  // the dev host; this also supports an HMR origin configured for ADSSO.
  request.setHeader("Origin", origin);
}

export function createPlatformClawDevProxy(
  target: string,
  ws = false,
  requestOrigin = target,
): ProxyOptions {
  return {
    target,
    changeOrigin: false,
    secure: false,
    ...(ws ? { ws: true } : {}),
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq) => setBackendOrigin(proxyReq, requestOrigin));
      proxy.on("proxyReqWs", (proxyReq) => setBackendOrigin(proxyReq, requestOrigin));
    },
  };
}

export function createPlatformClawDevConfig(
  backendOrigin = resolvePlatformClawDevBackendOrigin(),
  requestOrigin = resolvePlatformClawDevRequestOrigin(backendOrigin),
): UserConfig {
  const baseConfig = controlUiViteConfig();
  const proxy = Object.fromEntries(
    PLATFORMCLAW_DEV_PROXY_PATHS.map((pathname) => [
      pathname,
      createPlatformClawDevProxy(
        backendOrigin,
        pathname === "/platformclaw/gateway",
        requestOrigin,
      ),
    ]),
  );
  return {
    ...baseConfig,
    // Vite serves source modules from the repository root in dev. The
    // PlatformClaw adapter infers /platformclaw from the browser route.
    base: "/",
    server: {
      ...(baseConfig.server ?? {}),
      proxy,
    },
    plugins: [
      ...(baseConfig.plugins ?? []),
      platformClawDescriptorPlugin(),
      platformClawBootstrapConfigPlugin(),
    ],
  };
}

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, repoRoot, "");
  const backendUrl =
    process.env.PLATFORMCLAW_DEV_BACKEND_URL ?? fileEnv.PLATFORMCLAW_DEV_BACKEND_URL;
  const backendOrigin = resolvePlatformClawDevBackendOrigin(backendUrl);
  const requestOrigin =
    process.env.PLATFORMCLAW_DEV_REQUEST_ORIGIN ?? fileEnv.PLATFORMCLAW_DEV_REQUEST_ORIGIN;
  return createPlatformClawDevConfig(
    backendOrigin,
    resolvePlatformClawDevRequestOrigin(backendOrigin, requestOrigin),
  );
});
