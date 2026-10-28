import { lstat, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join } from "node:path";

export function deriveExecutionHandoffAddress(credentialBrokerAddress: string): string {
  if (process.platform === "win32") {
    if (!credentialBrokerAddress.startsWith("\\\\.\\pipe\\")) {
      throw new Error("Windows credential broker address must be a named pipe");
    }
    return `${credentialBrokerAddress}-execution`;
  }
  if (!isAbsolute(credentialBrokerAddress)) {
    throw new Error("credential broker socket path must be absolute");
  }
  return join(dirname(credentialBrokerAddress), "execution.sock");
}

export async function readExecutionSocket(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export type ExecutionSocketIdentity = {
  dev: number | bigint;
  ino: number | bigint;
};

export function assertExecutionSocketOwner(stats: Awaited<ReturnType<typeof lstat>>): void {
  if (!stats.isSocket() || stats.uid !== process.getuid?.()) {
    throw new Error("execution handoff path is not an owner-owned socket");
  }
}

export function executionSocketIdentity(
  stats: Awaited<ReturnType<typeof lstat>>,
): ExecutionSocketIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

export function executionSocketMatches(
  stats: Awaited<ReturnType<typeof lstat>>,
  identity: ExecutionSocketIdentity,
): boolean {
  return stats.dev === identity.dev && stats.ino === identity.ino;
}

export async function executionSocketAcceptsConnections(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

export async function removeUnchangedExecutionSocket(
  path: string,
  identity: ExecutionSocketIdentity,
): Promise<void> {
  const current = await readExecutionSocket(path);
  if (current && executionSocketMatches(current, identity)) {
    await rm(path);
  }
}
