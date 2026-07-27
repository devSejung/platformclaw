import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { promisify } from "node:util";
import { ControlPlaneStateError } from "./contracts.js";
import {
  normalizeObservedOpenSshHostKey,
  normalizeSafeConnectHost,
} from "./execution-validation.js";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 7_000;
const MAX_PROBE_ADDRESSES = 16;

export type SafeConnectProbeResult = {
  host: string;
  port: number;
  resolvedAddresses: string[];
  sshBanner: string;
  algorithm: "ssh-ed25519";
  publicKey: string;
  fingerprint: string;
};

type SafeConnectProbeDependencies = {
  lookupAll?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  readSshBanner?: (host: string, port: number) => Promise<string>;
  scanHostKey?: (host: string, port: number) => Promise<string>;
};

function classifyProbeError(error: unknown): ControlPlaneStateError {
  const rawCode =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : "";
  const message = error instanceof Error ? error.message : String(error);
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    return new ControlPlaneStateError("SafeConnect DNS lookup failed; verify the host name");
  }
  if (code === "ECONNREFUSED") {
    return new ControlPlaneStateError("SafeConnect refused the TCP connection; verify the port");
  }
  if (code === "ETIMEDOUT" || error instanceof DOMException || /timed out/iu.test(message)) {
    return new ControlPlaneStateError("SafeConnect connection timed out; verify network access");
  }
  if (/ssh-keyscan/iu.test(message) || /no ed25519/iu.test(message)) {
    return new ControlPlaneStateError(
      "SafeConnect did not provide an ED25519 host key; verify the SSH service",
    );
  }
  return new ControlPlaneStateError(`SafeConnect preflight failed: ${message.slice(0, 240)}`);
}

async function readSshBanner(host: string, port: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let received = "";
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy(Object.assign(new Error("SSH banner timed out"), { code: "ETIMEDOUT" }));
    }, PROBE_TIMEOUT_MS);
    const finish = (result: { banner?: string; error?: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result.error) {
        reject(result.error);
      } else if (result.banner) {
        resolve(result.banner);
      }
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.length > 8_192) {
        finish({ error: new Error("SSH banner exceeded the allowed size") });
        return;
      }
      const banner = received.split(/\r?\n/u).find((line) => line.startsWith("SSH-"));
      if (banner) {
        finish({ banner: banner.slice(0, 255) });
      }
    });
    socket.on("error", (error) => finish({ error }));
    socket.on("end", () => {
      finish({ error: new Error("SafeConnect closed before sending an SSH banner") });
    });
  });
}

async function scanHostKey(host: string, port: number): Promise<string> {
  const { stdout } = await execFileAsync(
    "ssh-keyscan",
    ["-T", String(Math.ceil(PROBE_TIMEOUT_MS / 1_000)), "-p", String(port), "-t", "ed25519", host],
    { timeout: PROBE_TIMEOUT_MS + 1_000, windowsHide: true, maxBuffer: 64 * 1024 },
  );
  return stdout;
}

function readEd25519HostKey(output: string) {
  const keyLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && /\s+ssh-ed25519\s+/u.test(line));
  if (!keyLine) {
    throw new Error("ssh-keyscan returned no ED25519 host key");
  }
  const parts = keyLine.split(/\s+/u);
  return normalizeObservedOpenSshHostKey({
    algorithm: "ssh-ed25519",
    publicKey: `${parts[1] ?? ""} ${parts[2] ?? ""}`,
  });
}

export async function probeSafeConnectEndpoint(
  params: { host: string; port: number },
  dependencies: SafeConnectProbeDependencies = {},
): Promise<SafeConnectProbeResult> {
  if (!Number.isInteger(params.port) || params.port < 1 || params.port > 65_535) {
    throw new ControlPlaneStateError("SafeConnect port must be an integer from 1 to 65535");
  }
  const host = normalizeSafeConnectHost(params.host);
  try {
    const addresses = await (dependencies.lookupAll ?? ((value) => lookup(value, { all: true })))(
      host,
    );
    const resolvedAddresses = [...new Set(addresses.map((entry) => entry.address))].toSorted();
    if (resolvedAddresses.length === 0) {
      throw new Error("SafeConnect DNS lookup returned no addresses");
    }
    if (resolvedAddresses.length > MAX_PROBE_ADDRESSES) {
      throw new Error(`SafeConnect DNS lookup returned more than ${MAX_PROBE_ADDRESSES} addresses`);
    }
    // VM administrators intentionally register private corporate endpoints. Resolve once, probe
    // every address, and require one key so DNS cannot switch the approved SSH service later.
    const observations = await Promise.all(
      resolvedAddresses.map(async (address) => ({
        banner: await (dependencies.readSshBanner ?? readSshBanner)(address, params.port),
        key: readEd25519HostKey(
          await (dependencies.scanHostKey ?? scanHostKey)(address, params.port),
        ),
      })),
    );
    const keysByFingerprint = new Map(
      observations.map((observation) => [observation.key.fingerprint, observation.key]),
    );
    if (keysByFingerprint.size !== 1) {
      throw new Error("SafeConnect addresses returned different ED25519 host keys");
    }
    const key = observations[0]!.key;
    return {
      host,
      port: params.port,
      resolvedAddresses,
      sshBanner: observations[0]!.banner,
      algorithm: "ssh-ed25519",
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
    };
  } catch (error) {
    throw classifyProbeError(error);
  }
}
