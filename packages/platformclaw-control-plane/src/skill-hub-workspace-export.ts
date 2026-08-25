import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import {
  SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
  SkillHubServiceError,
  UPLOAD_CHUNK_BYTES,
} from "./skill-hub-service-support.js";

type GatewayCall = <T>(method: string, params: unknown) => Promise<T>;

export async function downloadVmWorkspaceArchive(
  gatewayCall: GatewayCall,
  params: {
    agentId: string;
    slug: string;
    version: string;
    expectedTargetRevision: number;
    expectedAllocationId: string;
  },
): Promise<{ path: string; size: number; cleanup(): Promise<void> }> {
  const session = await gatewayCall<{ exportId?: string; token?: string }>(
    "platformclaw-execution.skillExport.begin",
    params,
  );
  if (
    typeof session.exportId !== "string" ||
    session.exportId.length > 128 ||
    typeof session.token !== "string" ||
    session.token.length > 128
  ) {
    throw new SkillHubServiceError("Gateway returned an invalid workspace export session", 503);
  }
  const request = { agentId: params.agentId, exportId: session.exportId, token: session.token };
  let directory: string | undefined;
  try {
    const deadline = Date.now() + 10 * 60_000;
    let size = 0;
    while (true) {
      const status = await gatewayCall<{ state?: string; size?: number }>(
        "platformclaw-execution.skillExport.status",
        request,
      );
      if (status.state === "ready") {
        if (
          typeof status.size !== "number" ||
          !Number.isSafeInteger(status.size) ||
          status.size <= 0 ||
          status.size > SKILL_HUB_UPLOAD_ARCHIVE_BYTES
        ) {
          throw new SkillHubServiceError("VM skill ZIP exceeds the 500 MiB upload limit", 413);
        }
        size = status.size;
        break;
      }
      if (status.state !== "preparing" || Date.now() >= deadline) {
        throw new SkillHubServiceError("VM workspace skill export timed out", 503);
      }
      await wait(150);
    }
    directory = await mkdtemp(path.join(tmpdir(), "platformclaw-vm-skill-export-"));
    const archivePath = path.join(directory, "archive.zip");
    const handle = await open(archivePath, "wx", 0o600);
    try {
      let offset = 0;
      while (offset < size) {
        const chunk = await gatewayCall<{ offset?: number; data?: string; done?: boolean }>(
          "platformclaw-execution.skillExport.read",
          { ...request, offset },
        );
        if (
          chunk.offset !== offset ||
          typeof chunk.data !== "string" ||
          chunk.data.length > 512 * 1024 ||
          !/^[A-Za-z0-9+/]+={0,2}$/u.test(chunk.data)
        ) {
          throw new SkillHubServiceError("Gateway returned an invalid workspace export chunk", 503);
        }
        const bytes = Buffer.from(chunk.data, "base64");
        if (
          bytes.length === 0 ||
          bytes.length > UPLOAD_CHUNK_BYTES ||
          offset + bytes.length > size ||
          chunk.done !== (offset + bytes.length === size)
        ) {
          throw new SkillHubServiceError(
            "Gateway returned a mismatched workspace export chunk",
            503,
          );
        }
        // FileHandle.write can complete partially under disk pressure; writeFile
        // keeps writing until the complete bounded RPC chunk reaches disk.
        await handle.writeFile(bytes);
        offset += bytes.length;
      }
    } finally {
      await handle.close();
    }
    const archiveDirectory = directory;
    return {
      path: archivePath,
      size,
      cleanup: async () => await rm(archiveDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await gatewayCall("platformclaw-execution.skillExport.close", request).catch(() => undefined);
  }
}
