#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { redeemLocalCredentialGrant } from "./credential-broker-local.js";
import { ExecutionHandoffClient } from "./execution-handoff-client.js";
import { deriveExecutionHandoffAddress } from "./execution-handoff-http.js";

type SshpassContext = {
  agentId: string;
  allocationId: string;
  targetRevision: number;
  credentialRevision: number;
  credentialBrokerAddress?: string;
  credentialGrantToken?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredContext(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized !== value) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

async function readContext(argv: string[]): Promise<SshpassContext> {
  const configIndex = argv.indexOf("-F");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : undefined;
  if (!configPath) {
    throw new Error("SSH config path is missing");
  }
  return JSON.parse(
    await readFile(path.join(path.dirname(configPath), "platformclaw-context.json"), "utf8"),
  ) as SshpassContext;
}

async function run(): Promise<number> {
  const sshArgs = process.argv.slice(2);
  const context = await readContext(sshArgs);
  const token = (
    await readFile(requiredEnv("PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE"), "utf8")
  ).trim();
  const client = new ExecutionHandoffClient(
    deriveExecutionHandoffAddress(requiredEnv("PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS")),
    token,
  );
  const grant = context.credentialGrantToken
    ? {
        brokerAddress: requiredContext(
          context.credentialBrokerAddress,
          "credential broker runtime address",
        ),
        token: context.credentialGrantToken,
      }
    : await client.issueCredentialGrant(context);
  const credential = await redeemLocalCredentialGrant({
    address: grant.brokerAddress,
    token: grant.token,
  });
  if (!context.credentialGrantToken && credential.revision !== context.credentialRevision) {
    credential.password.fill(0);
    throw new Error("credential changed before SSH authentication");
  }
  const passwordInput = Buffer.concat([credential.password, Buffer.from("\n")]);
  credential.password.fill(0);
  let passwordCleared = false;
  const clearPassword = (): void => {
    if (!passwordCleared) {
      passwordCleared = true;
      passwordInput.fill(0);
    }
  };
  try {
    const child = spawn("sshpass", ["-d", "3", "ssh", ...sshArgs], {
      env: process.env,
      stdio: ["inherit", "inherit", "inherit", "pipe"],
    });
    const passwordPipe = child.stdio[3] as Writable | null;
    if (!passwordPipe) {
      throw new Error("sshpass credential pipe is unavailable");
    }
    let forceKill: NodeJS.Timeout | undefined;
    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (!child.killed) {
        child.kill(signal);
        forceKill ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
        forceKill.unref();
      }
    };
    const onSigint = (): void => forwardSignal("SIGINT");
    const onSigterm = (): void => forwardSignal("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    try {
      const childExit = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (signal) {
            reject(new Error(`sshpass terminated by ${signal}`));
          } else {
            resolve(code ?? 1);
          }
        });
      });
      const passwordWrite = new Promise<void>((resolve, reject) => {
        passwordPipe.once("error", (error) => {
          clearPassword();
          reject(error);
        });
        passwordPipe.end(passwordInput, () => {
          clearPassword();
          resolve();
        });
      });
      const [code] = await Promise.all([childExit, passwordWrite]);
      return code;
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      if (forceKill) {
        clearTimeout(forceKill);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  } finally {
    clearPassword();
  }
}

run().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `PlatformClaw SSH authentication failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exit(1);
  },
);
