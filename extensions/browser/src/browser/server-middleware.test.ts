import { EventEmitter } from "node:events";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./server-middleware.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

let server: http.Server | undefined;

async function startMiddlewareTestServer(): Promise<{ url: string; getRouteCalls: () => number }> {
  const app = express();
  let routeCalls = 0;
  installBrowserCommonMiddleware(app);
  installBrowserAuthMiddleware(app, { token: "test-token" });
  app.post("/mutate", (req, res) => {
    routeCalls += 1;
    res.status(200).json({ body: req.body });
  });

  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => {
    server?.once("listening", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP test server address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    getRouteCalls: () => routeCalls,
  };
}

afterEach(async () => {
  const current = server;
  server = undefined;
  if (!current) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    current.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("installBrowserCommonMiddleware", () => {
  it.each([
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const)(
    "parses allowed %s JSON and enforces the inflated body limit",
    async (encoding, compress) => {
      const { url, getRouteCalls } = await startMiddlewareTestServer();
      for (const oversized of [false, true]) {
        const body = { value: oversized ? "x".repeat(1024 * 1024) : "compressed request" };
        const response = await fetch(`${url}/mutate`, {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
            "content-encoding": encoding,
          },
          body: new Uint8Array(compress(JSON.stringify(body))),
        });
        expect(response.status).toBe(oversized ? 413 : 200);
        if (oversized) {
          await response.text();
        } else {
          expect(await response.json()).toEqual({ body });
        }
      }
      expect(getRouteCalls()).toBe(1);
    },
  );

  it("finishes a compressed request whose decoder completes before the HTTP body", async () => {
    const app = express();
    installBrowserCommonMiddleware(app);
    installBrowserAuthMiddleware(app, { token: "test-token" });
    const first = Buffer.concat([deflateSync('{"ok":true}'), Buffer.from([0])]);
    const trailing = Buffer.alloc(1024);
    let client: http.ClientRequest | undefined;
    app.post("/mutate", (req, res) => {
      // Exercise downstream request-completion work after parsing. The decoder
      // must detach and drain remaining HTTP bytes instead of leaving it hung.
      req.once("end", () => res.json({ body: req.body }));
      client?.end(trailing);
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => {
      server?.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP test server address");
    }
    try {
      const result = await new Promise<{ status: number | undefined; body: string }>(
        (resolve, reject) => {
          client = http.request(
            {
              host: "127.0.0.1",
              port: address.port,
              path: "/mutate",
              method: "POST",
              agent: false,
              headers: {
                authorization: "Bearer test-token",
                "content-type": "application/json",
                "content-encoding": "deflate",
                "content-length": first.length + trailing.length,
              },
            },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk: string) => {
                body += chunk;
              });
              response.on("error", reject);
              response.on("end", () => resolve({ status: response.statusCode, body }));
            },
          );
          client.on("error", reject);
          client.setTimeout(2000, () =>
            client?.destroy(new Error("compressed HTTP request did not finish")),
          );
          client.write(first);
        },
      );
      expect(result).toEqual({ status: 200, body: '{"body":{"ok":true}}' });
    } finally {
      client?.destroy();
    }
  });

  it("keeps serving after trailing bytes reach a finished gzip decoder", async () => {
    const { url, getRouteCalls } = await startMiddlewareTestServer();
    const encoded = Buffer.concat([
      gzipSync('{"ok":true}'),
      Buffer.from([0]),
      Buffer.alloc(100 * 1024, 0x58),
    ]);
    const response = await fetch(`${url}/mutate`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: new Uint8Array(encoded),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: { ok: true } });
    // GHSA-27r3-jxmh-p828 raises a late, unhandled decoder error after the
    // response. Keep that event observable before proving the server still works.
    await delay(200);
    const next = await fetch(`${url}/mutate`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: '{"stillRunning":true}',
    });
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ body: { stillRunning: true } });
    expect(getRouteCalls()).toBe(2);
  });

  it("shadows native request signals with the browser response-lifetime signal", () => {
    const middleware: Middleware[] = [];
    const app = {
      use: vi.fn((...handlers: unknown[]) => {
        for (const handler of handlers) {
          if (typeof handler === "function") {
            middleware.push(handler as Middleware);
          }
        }
        return app;
      }),
    } as unknown as Express;
    installBrowserCommonMiddleware(app);

    const nativeController = new AbortController();
    const req = new EventEmitter() as EventEmitter & Request;
    const requestPrototype = Object.create(Object.getPrototypeOf(req)) as object;
    Object.defineProperty(requestPrototype, "signal", {
      configurable: true,
      get: () => nativeController.signal,
    });
    Object.setPrototypeOf(req, requestPrototype);

    const res = new EventEmitter() as EventEmitter & Response;
    Object.defineProperty(res, "writableEnded", { value: false, writable: true });
    const next = vi.fn();
    const commonMiddleware = middleware[0];
    if (!commonMiddleware) {
      throw new Error("browser common middleware was not installed");
    }

    commonMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(Object.hasOwn(req, "signal")).toBe(true);
    expect(req.signal).not.toBe(nativeController.signal);
    expect(req.signal.aborted).toBe(false);

    req.emit("aborted");
    expect(req.signal.aborted).toBe(true);
    expect(req.signal.reason).toEqual(new Error("request aborted"));
  });

  it("rejects cross-site mutations before JSON body parsing", async () => {
    const { url, getRouteCalls } = await startMiddlewareTestServer();

    const response = await fetch(`${url}/mutate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: "{not json",
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
    expect(getRouteCalls()).toBe(0);
  });

  it("still parses allowed JSON requests after the mutation guard", async () => {
    const { url, getRouteCalls } = await startMiddlewareTestServer();

    const response = await fetch(`${url}/mutate`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ok: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: { ok: true } });
    expect(getRouteCalls()).toBe(1);
  });
});
