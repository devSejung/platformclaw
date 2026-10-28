// Runs only inside the task-owned runtime smoke containers, against synthetic state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  deriveExecutionHandoffAddress,
  ExecutionHandoffClient,
  GatewayAdminRpcError,
  HttpGatewayAdminRpcClient,
  loadPlatformClawDeploymentConfig,
  PLATFORMCLAW_EXECUTION_AUTH_FAILURE_PATH,
} from "/app/packages/platformclaw-control-plane/dist/index.mjs";

const action = process.argv[2];
const agentId = "person_one";
const authority = (target) => ({
  agentId: target.agentId,
  allocationId: target.allocationId,
  targetRevision: target.revision,
  credentialRevision: target.credentialRevision,
});

async function rawFinalRejection(target) {
  assert.equal(target.agentId, agentId);
  assert.equal(target.linuxAccount, "person_one");
  const directory = await mkdtemp(path.join(tmpdir(), "platformclaw-reauth-ssh-"));
  try {
    const config = path.join(directory, "config");
    const knownHosts = path.join(directory, "known_hosts");
    const username = `${target.adDomain}\\${target.adAccount}+${target.linuxAccount}+${target.targetAddress}`;
    await writeFile(
      knownHosts,
      `[${target.endpointHost}]:${target.endpointPort} ${target.hostKeyAlgorithm} ${target.hostKeyPublicKey}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      config,
      [
        "Host reauth-fixture",
        `  HostName ${target.endpointHost}`,
        `  Port ${target.endpointPort}`,
        `  User ${username}`,
        "  PreferredAuthentications keyboard-interactive",
        "  KbdInteractiveAuthentication yes",
        "  PasswordAuthentication no",
        "  NumberOfPasswordPrompts 1",
        "  StrictHostKeyChecking yes",
        `  UserKnownHostsFile ${knownHosts}`,
        "  GlobalKnownHostsFile /dev/null",
        "  ConnectTimeout 5",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const code = await new Promise((resolve, reject) => {
      const child = spawn(
        "sshpass",
        ["-d", "3", "ssh", "-F", config, "-M", "-N", "reauth-fixture"],
        {
          stdio: ["ignore", "ignore", "ignore", "pipe"],
        },
      );
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("raw fixture authentication did not settle"));
      }, 15_000);
      child.once("error", reject);
      child.once("close", (exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
      child.stdio[3].on("error", reject);
      child.stdio[3].end("platformclaw-safeconnect-fixture-password\n");
    });
    assert.equal(code, 255, "final SSH authentication rejection must exercise the 255 path");
    console.log(JSON.stringify({ exit: code }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function postFailure(config, body) {
  return await new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = request(
      {
        socketPath: deriveExecutionHandoffAddress(config.credentialBrokerAddress),
        path: PLATFORMCLAW_EXECUTION_AUTH_FAILURE_PATH,
        method: "POST",
        headers: {
          authorization: `Bearer ${config.executionServiceToken}`,
          "content-type": "application/json",
          "content-length": payload.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.once("end", () => {
          try {
            assert.equal(res.statusCode, 200);
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Invalid VM recovery response"));
          }
        });
        res.once("error", reject);
      },
    );
    req.setTimeout(5_000, () => req.destroy(new Error("recovery report timed out")));
    req.once("error", reject);
    req.end(payload);
  });
}

if (action === "raw-final-rejection") {
  await rawFinalRejection(JSON.parse(readFileSync(0, "utf8")));
} else {
  const config = loadPlatformClawDeploymentConfig();
  const rpc = new HttpGatewayAdminRpcClient({
    rpcUrl: config.gatewayAdminRpcUrl,
    bearerToken: config.gatewayAuth,
  });
  const handoff = new ExecutionHandoffClient(
    deriveExecutionHandoffAddress(config.credentialBrokerAddress),
    config.executionServiceToken,
  );
  const resolveTarget = async () => {
    const target = await handoff.resolveTarget(agentId, "assigned_vm");
    assert.equal(target.kind, "assigned_vm");
    assert.equal(target.agentId, agentId);
    return target;
  };
  const probe = async (target, expectedKind) => {
    const current = await resolveTarget();
    const grant = await handoff.issueCredentialGrant(authority(current));
    await assert.rejects(
      rpc.call("platformclaw-execution.testCandidateConnection", {
        target,
        credentialBrokerAddress: grant.brokerAddress,
        credentialGrantToken: grant.token,
      }),
      (error) => error instanceof GatewayAdminRpcError && error.details?.kind === expectedKind,
    );
  };
  if (action === "target") {
    console.log(JSON.stringify(await resolveTarget()));
  } else if (action === "report-ignored") {
    const target = JSON.parse(readFileSync(0, "utf8"));
    assert.deepEqual(await postFailure(config, authority(target)), { recorded: false });
    console.log(JSON.stringify({ ignored: true }));
  } else if (action === "ready" || action === "rejected") {
    const operation = rpc.call("skills.status", {
      agentId,
      backendTarget: "assigned_vm",
      refresh: true,
    });
    if (action === "ready") {
      const result = await operation;
      assert.ok(result && typeof result === "object");
    } else {
      await assert.rejects(operation, (error) => error instanceof GatewayAdminRpcError);
    }
    console.log(JSON.stringify({ [action]: true }));
  } else if (action === "command-failure") {
    await probe(await resolveTarget(), "vm_connection_failed");
    console.log(JSON.stringify({ remoteCommandWasNotAuthenticationFailure: true }));
  } else if (action === "connection-errors") {
    const target = await resolveTarget();
    await probe({ ...target, endpointPort: 1 }, "vm_connection_refused");
    await probe({ ...target, endpointHost: "missing-safeconnect.invalid" }, "vm_dns_failed");
    const key = Buffer.from(target.hostKeyPublicKey, "base64");
    key[key.length - 1] ^= 1;
    await probe(
      {
        ...target,
        hostKeyPublicKey: key.toString("base64"),
        hostKeyFingerprint: `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`,
      },
      "vm_host_key_failed",
    );
    console.log(JSON.stringify({ nonAuthenticationErrorsStayedDistinct: true }));
  } else {
    throw new Error("unknown runtime recovery proof action");
  }
}
