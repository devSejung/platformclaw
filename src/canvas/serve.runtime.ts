/** Gateway runtime for core-owned Canvas document HTTP responses. */
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import { FsSafeError, root as fsRoot } from "../infra/fs-safe.js";
import {
  resolveCanvasDocumentsDir,
  resolveCanvasHttpPathToLocalPath,
  type CanvasDocumentManifest,
} from "./documents.js";

/** Trusted reverse proxies may pin a Canvas read to its creating agent. */
export const CANVAS_OWNER_AGENT_HEADER = "x-openclaw-canvas-owner-agent-id";

async function readRootFile(root: Awaited<ReturnType<typeof fsRoot>>, relativePath: string) {
  try {
    const opened = await root.open(relativePath);
    try {
      return { data: await opened.handle.readFile(), realPath: opened.realPath };
    } finally {
      await opened.handle.close().catch(() => {});
    }
  } catch (error) {
    if (error instanceof FsSafeError) {
      return null;
    }
    throw error;
  }
}

async function readDocumentManifest(
  root: Awaited<ReturnType<typeof fsRoot>>,
  relativePath: string,
): Promise<CanvasDocumentManifest | undefined> {
  const documentId = relativePath.split(path.sep)[0];
  if (!documentId) {
    return undefined;
  }
  const opened = await readRootFile(root, path.join(documentId, "manifest.json"));
  if (!opened) {
    return undefined;
  }
  try {
    return JSON.parse(opened.data.toString("utf8")) as CanvasDocumentManifest;
  } catch {
    return undefined;
  }
}

/** Serves one managed Canvas document request. */
export async function handleCanvasDocumentHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const localPath = resolveCanvasHttpPathToLocalPath(req.url ?? "");
  if (!localPath) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  try {
    const documentsDir = resolveCanvasDocumentsDir();
    const relativePath = path.relative(documentsDir, localPath);
    const root = await fsRoot(documentsDir);
    const manifest = await readDocumentManifest(root, relativePath);
    const requiredOwner = req.headers[CANVAS_OWNER_AGENT_HEADER];
    if (
      requiredOwner !== undefined &&
      (typeof requiredOwner !== "string" ||
        !requiredOwner ||
        manifest?.ownerAgentId !== requiredOwner)
    ) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("not found");
      return true;
    }
    const opened = await readRootFile(root, relativePath);
    if (!opened) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("not found");
      return true;
    }

    const lowerPath = opened.realPath.toLowerCase();
    const mime =
      lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")
        ? "text/html"
        : ((await detectMime({ filePath: opened.realPath })) ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    if (mime === "text/html") {
      // Measure the decoded representation: toString("utf8") expands invalid
      // bytes to U+FFFD, so the raw file length can differ from the body sent.
      const body = opened.data.toString("utf8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Length", String(Buffer.byteLength(body)));
      if (manifest?.cspSandbox === "scripts") {
        res.setHeader("Content-Security-Policy", "sandbox allow-scripts");
      }
      if (req.method === "HEAD") {
        res.end();
        return true;
      }
      res.end(body);
      return true;
    }
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(opened.data.byteLength));
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    res.end(opened.data);
    return true;
  } catch (error) {
    res.statusCode = error instanceof FsSafeError ? 404 : 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(error instanceof FsSafeError ? "not found" : "error");
    return true;
  }
}
