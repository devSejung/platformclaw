import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUserMcpConnectionRuntime } from "./runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("createUserMcpConnectionRuntime", () => {
  it("validates broker configuration and reads the service token during startup", () => {
    const root = mkdtempSync(join(tmpdir(), "platformclaw-user-mcp-runtime-"));
    roots.push(root);
    const tokenFile = join(root, "execution-token");
    writeFileSync(tokenFile, "service-token\n", { encoding: "utf8", mode: 0o600 });

    expect(() =>
      createUserMcpConnectionRuntime({
        PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS: join(root, "credential.sock"),
        PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE: tokenFile,
      }),
    ).not.toThrow();
    expect(() =>
      createUserMcpConnectionRuntime({
        PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS: join(root, "credential.sock"),
        PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE: join(root, "missing-token"),
      }),
    ).toThrow();
  });
});
