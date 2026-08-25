import { randomUUID, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PlatformClawTargetMutationCoordinator } from "./target-mutation-coordinator.js";

const EXPORT_CHUNK_BYTES = 384 * 1024;
const EXPORT_IDLE_TIMEOUT_MS = 120_000;
const EXPORT_PREPARATION_TIMEOUT_MS = 10 * 60_000;
const MAX_EXPORT_SESSIONS = 32;
const SKILL_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

type PlatformClawExportedSkillArchive = {
  path: string;
  size: number;
  cleanup(): Promise<void>;
};

export type PlatformClawSkillExportRuntime = {
  exportWorkspaceSkill(params: {
    agentId: string;
    slug: string;
    version: string;
    expectedTargetRevision: number;
    expectedAllocationId: string;
    signal: AbortSignal;
  }): Promise<PlatformClawExportedSkillArchive>;
};

type ExportSession = {
  agentId: string;
  token: string;
  controller: AbortController;
  state: "preparing" | "ready" | "failed";
  archive?: PlatformClawExportedSkillArchive;
  failure?: string;
  timer: NodeJS.Timeout;
};

type GatewayApi = Pick<OpenClawPluginApi, "logger" | "registerGatewayMethod">;

function authorizedSession(
  sessions: Map<string, ExportSession>,
  input: Record<string, unknown>,
): ExportSession | undefined {
  if (
    typeof input.agentId !== "string" ||
    typeof input.exportId !== "string" ||
    typeof input.token !== "string"
  ) {
    return undefined;
  }
  const session = sessions.get(input.exportId);
  if (!session || session.agentId !== input.agentId) {
    return undefined;
  }
  const actual = Buffer.from(input.token);
  const expected = Buffer.from(session.token);
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? session
    : undefined;
}

export function registerPlatformClawSkillExportGateway(
  api: GatewayApi,
  runtimePromise: Promise<PlatformClawSkillExportRuntime>,
  targetMutations: PlatformClawTargetMutationCoordinator,
): () => Promise<void> {
  const sessions = new Map<string, ExportSession>();

  const remove = async (exportId: string): Promise<void> => {
    const session = sessions.get(exportId);
    if (!session) {
      return;
    }
    sessions.delete(exportId);
    clearTimeout(session.timer);
    session.controller.abort();
    await session.archive?.cleanup().catch((error: unknown) => {
      api.logger.warn?.(
        `[platformclaw-execution] workspace export cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    });
  };

  const refreshTimeout = (exportId: string, session: ExportSession): void => {
    clearTimeout(session.timer);
    session.timer = setTimeout(
      () => void remove(exportId),
      session.state === "preparing" ? EXPORT_PREPARATION_TIMEOUT_MS : EXPORT_IDLE_TIMEOUT_MS,
    );
    session.timer.unref();
  };

  api.registerGatewayMethod(
    "platformclaw-execution.skillExport.begin",
    async ({ params, respond }) => {
      const input = params as Record<string, unknown>;
      const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
      const slug = typeof input.slug === "string" ? input.slug.trim() : "";
      const version = typeof input.version === "string" ? input.version.trim() : "";
      const expectedTargetRevision = input.expectedTargetRevision;
      const expectedAllocationId =
        typeof input.expectedAllocationId === "string" ? input.expectedAllocationId.trim() : "";
      if (
        !agentId ||
        !SKILL_SLUG_PATTERN.test(slug) ||
        !version ||
        version.length > 128 ||
        !expectedAllocationId ||
        expectedAllocationId.length > 128 ||
        typeof expectedTargetRevision !== "number" ||
        !Number.isSafeInteger(expectedTargetRevision) ||
        expectedTargetRevision < 0
      ) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "workspace skill export request is invalid",
        });
        return;
      }
      if (sessions.size >= MAX_EXPORT_SESSIONS) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "workspace skill export capacity is unavailable; retry shortly",
        });
        return;
      }
      const release = targetMutations.tryAcquire(agentId, "skill-export");
      if (!release) {
        respond(false, undefined, {
          code: "CONFLICT",
          message: "work location or workspace skill mutation is already in progress",
        });
        return;
      }
      const exportId = randomUUID();
      const token = randomUUID();
      const controller = new AbortController();
      const session: ExportSession = {
        agentId,
        token,
        controller,
        state: "preparing",
        timer: setTimeout(() => void remove(exportId), EXPORT_PREPARATION_TIMEOUT_MS),
      };
      session.timer.unref();
      sessions.set(exportId, session);
      // VM packaging can exceed the Admin RPC deadline. Return the capability
      // immediately and expose readiness through separate bounded requests.
      void runtimePromise
        .then(
          async (runtime) =>
            await runtime.exportWorkspaceSkill({
              agentId,
              slug,
              version,
              expectedTargetRevision,
              expectedAllocationId,
              signal: controller.signal,
            }),
        )
        .then(async (archive) => {
          if (sessions.get(exportId) !== session || controller.signal.aborted) {
            await archive.cleanup();
            return;
          }
          session.archive = archive;
          session.state = "ready";
          refreshTimeout(exportId, session);
        })
        .catch((error: unknown) => {
          if (sessions.get(exportId) !== session || controller.signal.aborted) {
            return;
          }
          session.state = "failed";
          session.failure =
            error instanceof Error ? error.message : "workspace skill export failed";
          refreshTimeout(exportId, session);
        })
        .finally(release);
      respond(true, { exportId, token });
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    "platformclaw-execution.skillExport.status",
    async ({ params, respond }) => {
      const input = params as Record<string, unknown>;
      const session = authorizedSession(sessions, input);
      if (!session) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "workspace export expired" });
        return;
      }
      if (session.state === "failed") {
        const failure = session.failure ?? "workspace skill export failed";
        await remove(input.exportId as string);
        respond(false, undefined, { code: "INVALID_REQUEST", message: failure });
        return;
      }
      if (session.state === "preparing") {
        respond(true, { state: "preparing" });
        return;
      }
      refreshTimeout(input.exportId as string, session);
      respond(true, { state: "ready", size: session.archive!.size });
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    "platformclaw-execution.skillExport.read",
    async ({ params, respond }) => {
      const input = params as Record<string, unknown>;
      const session = authorizedSession(sessions, input);
      const offset = input.offset;
      if (
        !session?.archive ||
        session.state !== "ready" ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset >= session.archive.size
      ) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "workspace export read request is invalid",
        });
        return;
      }
      refreshTimeout(input.exportId as string, session);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(session.archive.path, "r");
        const buffer = Buffer.alloc(Math.min(EXPORT_CHUNK_BYTES, session.archive.size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead !== buffer.length) {
          throw new Error("workspace export changed during transfer");
        }
        respond(true, {
          offset,
          data: buffer.toString("base64"),
          done: offset + bytesRead === session.archive.size,
        });
      } catch {
        await remove(input.exportId as string);
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "workspace export could not be read",
        });
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    "platformclaw-execution.skillExport.close",
    async ({ params, respond }) => {
      const input = params as Record<string, unknown>;
      if (!authorizedSession(sessions, input)) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "workspace export expired" });
        return;
      }
      await remove(input.exportId as string);
      respond(true, { ok: true });
    },
    { scope: "operator.admin" },
  );

  return async () => {
    await Promise.allSettled([...sessions.keys()].map(async (exportId) => await remove(exportId)));
  };
}
