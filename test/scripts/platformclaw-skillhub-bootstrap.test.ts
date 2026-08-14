import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("PlatformClaw SkillHub bootstrap", () => {
  it("uses the exact direct-auth, namespace, and token contracts without leaking credentials", async () => {
    const requests: Array<{ body: string; cookie?: string; csrf?: string; path: string }> = [];
    const server = createServer(async (request, response) => {
      const body = await new Promise<string>((resolve) => {
        let value = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => (value += chunk));
        request.on("end", () => resolve(value));
      });
      requests.push({
        body,
        cookie: request.headers.cookie,
        csrf: request.headers["x-xsrf-token"] as string | undefined,
        path: request.url ?? "",
      });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/auth/methods") {
        response.setHeader("set-cookie", "XSRF-TOKEN=csrf-value; Path=/");
        response.end('{"code":0,"data":[]}');
      } else if (request.url === "/api/v1/auth/direct/login") {
        response.setHeader("set-cookie", "SESSION=session-value; Path=/; HttpOnly");
        response.end('{"code":0,"data":{}}');
      } else if (request.url === "/api/v1/namespaces?size=200") {
        response.end('{"code":0,"data":{"items":[{"slug":"global"}]}}');
      } else if (request.url === "/api/v1/namespaces") {
        response.end('{"code":0,"data":{"slug":"engineering"}}');
      } else if (request.url === "/api/v1/tokens") {
        response.end('{"code":0,"data":{"token":"sk_bootstrap-result"}}');
      } else {
        response.statusCode = 404;
        response.end('{"code":404}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    const root = mkdtempSync(join(tmpdir(), "platformclaw-skillhub-bootstrap-"));
    temporaryDirectories.push(root);
    const passwordFile = join(root, "password");
    const tokenFile = join(root, "token");
    writeFileSync(passwordFile, "never-log-this-password\n", { mode: 0o400 });
    writeFileSync(tokenFile, "", { mode: 0o600 });
    const script = new URL(
      "../../docker/platformclaw-runtime/bootstrap-skillhub.mjs",
      import.meta.url,
    );
    const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>(
      (resolve) => {
        const child = spawn(process.execPath, [fileURLToPath(script)], {
          env: {
            ...process.env,
            SKILLHUB_BASE_URL: `http://127.0.0.1:${address.port}`,
            SKILLHUB_BOOTSTRAP_PASSWORD_FILE: passwordFile,
            SKILLHUB_CREATE_TOKEN: "true",
            SKILLHUB_NAMESPACES: "global=all,engineering=developers",
            SKILLHUB_TOKEN_OUTPUT_FILE: tokenFile,
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => resolve({ code, stderr, stdout }));
      },
    );
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

    expect(result).toEqual({ code: 0, stderr: "", stdout: "" });
    expect(readFileSync(tokenFile, "utf8")).toBe("sk_bootstrap-result\n");
    const login = requests.find((request) => request.path.endsWith("/auth/direct/login"));
    expect(JSON.parse(login?.body ?? "{}")).toEqual({
      provider: "local",
      username: "platformclaw-bootstrap",
      password: "never-log-this-password",
    });
    expect(login?.csrf).toBe("csrf-value");
    const namespace = requests.find((request) => request.path === "/api/v1/namespaces");
    expect(JSON.parse(namespace?.body ?? "{}")).toMatchObject({ slug: "engineering" });
    expect(namespace?.cookie).toContain("SESSION=session-value");
    const token = requests.find((request) => request.path === "/api/v1/tokens");
    expect(JSON.parse(token?.body ?? "{}")).toEqual({
      name: "platformclaw-control",
      scopes: ["skill:read", "skill:publish"],
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain("never-log-this-password");
  });
});
