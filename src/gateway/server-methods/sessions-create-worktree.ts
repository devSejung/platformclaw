import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { insideGitCheckout } from "../../agents/worktrees/git.js";
import { slugifyWorktreeTitle } from "../../agents/worktrees/name.js";
import { managedWorktrees, WorktreeRepositoryError } from "../../agents/worktrees/service.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { stripInlineDirectiveTagsForDisplay } from "../../utils/directive-tags.js";
import { generateDashboardSessionTitle } from "../dashboard-session-title.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { buildDashboardSessionKey } from "../session-create-service.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import { loadSessionEntryReadOnly, resolveGatewaySessionStoreTarget } from "../session-utils.js";
import { resolveSessionPatchModelSelection } from "../sessions-patch.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type SessionWorktree = Awaited<ReturnType<typeof managedWorktrees.create>>;

type PreparedSessionWorktree = {
  sessionKey?: string;
  sessionAgentId?: string;
  sessionWorktree: SessionWorktree;
  sessionCwd: string;
  sessionSourceRoot: string;
  provisionedSessionWorktree: boolean;
};

type CatalogCreateTarget = { target: { model: string } };

/** Provision or adopt the checkout used by a worktree-backed dashboard session. */
export async function prepareSessionWorktree(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  context: GatewayRequestContext;
  hasInitialTurn: boolean;
  initialMessage?: string;
  p: SessionsCreateParams;
  catalogTarget?: CatalogCreateTarget;
  sessionAgentId?: string;
  sessionKey?: string;
  respond: RespondFn;
}): Promise<PreparedSessionWorktree | undefined> {
  const { cfg, client, context, hasInitialTurn, initialMessage, p, catalogTarget, respond } =
    params;
  if (p.worktree !== true) {
    return undefined;
  }

  const requestedCwd = normalizeOptionalString(p.cwd);
  const requestedWorktreeBaseRef = normalizeOptionalString(p.worktreeBaseRef);
  const requestedWorktreeName = normalizeOptionalString(p.worktreeName);
  const explicitKey = normalizeOptionalString(p.key);
  const requestedKey = explicitKey ?? "global";
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, requestedKey, p.agentId);
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return undefined;
  }
  const agentId = normalizeAgentId(
    requestedAgent.agentId ??
      normalizeOptionalString(p.agentId) ??
      parseAgentSessionKey(requestedKey)?.agentId ??
      resolveDefaultAgentId(cfg),
  );
  let targetKey = explicitKey;
  let preservesUnspecifiedKey = false;
  const parentSessionKey = normalizeOptionalString(p.parentSessionKey);
  if (
    !targetKey &&
    parentSessionKey &&
    p.emitCommandHooks === true &&
    !hasInitialTurn &&
    cfg.session?.dmScope === "main"
  ) {
    const parent = loadSessionEntryReadOnly(
      parentSessionKey,
      requestedAgent.agentId ? { agentId: requestedAgent.agentId } : undefined,
    );
    const parentAgentId = normalizeAgentId(
      requestedAgent.agentId ?? resolveSessionStoreAgentId(cfg, parent.canonicalKey),
    );
    if (
      parent.entry?.sessionId &&
      parent.canonicalKey === resolveAgentMainSessionKey({ cfg, agentId: parentAgentId })
    ) {
      targetKey = parent.canonicalKey;
      preservesUnspecifiedKey = true;
    }
  }
  targetKey ??= buildDashboardSessionKey(agentId);
  const target = resolveGatewaySessionStoreTarget({ cfg, key: targetKey, agentId });
  const sessionKey = preservesUnspecifiedKey ? undefined : targetKey;
  const sessionAgentId = target.agentId;
  const workspace = requestedCwd ?? resolveAgentWorkspaceDir(cfg, target.agentId);
  // Subdirectory workspaces are valid: the worktree service resolves the repo root
  // via git discovery, so the preflight must accept ancestor .git entries too.
  if (!insideGitCheckout(workspace)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "agent workspace is not a git checkout"),
    );
    return undefined;
  }

  let sessionWorktree: SessionWorktree;
  let sessionSourceRoot: string;
  let provisionedSessionWorktree = false;
  try {
    const requestedRepository = await managedWorktrees.resolveRepositoryPaths(workspace);
    sessionSourceRoot = requestedRepository.sourceRoot;
    const existing = managedWorktrees.findLiveByOwner("session", target.canonicalKey);
    let existingDirectory = false;
    if (existing) {
      try {
        existingDirectory = fs.lstatSync(existing.path).isDirectory();
      } catch {
        // Missing registry targets are replaced; periodic GC retires their stale rows.
      }
    }
    if (existing && existingDirectory) {
      if (existing.repoRoot !== requestedRepository.canonicalRoot) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "session worktree belongs to a different repository",
          ),
        );
        return undefined;
      }
      // Adopting an existing checkout cannot honor a different name or a new base;
      // fail loudly instead of silently ignoring the request.
      if (
        (requestedWorktreeName && existing.name !== requestedWorktreeName) ||
        requestedWorktreeBaseRef
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `session is already bound to worktree ${existing.name} (${existing.branch})`,
          ),
        );
        return undefined;
      }
      sessionWorktree = existing;
    } else {
      const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
      let generatedDisplayName: string | undefined;
      if (!requestedWorktreeName && !normalizeOptionalString(p.label) && initialMessage) {
        try {
          const requestedTitleModel =
            catalogTarget?.target.model ?? normalizeOptionalString(p.model);
          let titleModelEntry:
            | Pick<SessionEntry, "authProfileOverride" | "modelOverride" | "providerOverride">
            | undefined;
          if (requestedTitleModel) {
            const defaultModel = resolveDefaultModelForAgent({ cfg, agentId: target.agentId });
            const selection = resolveSessionPatchModelSelection({
              cfg,
              catalog: await context.loadGatewayModelCatalog({ agentId: target.agentId }),
              raw: requestedTitleModel,
              defaultProvider: defaultModel.provider,
              defaultModel: defaultModel.model,
            });
            if (selection.ok) {
              titleModelEntry = {
                providerOverride: selection.provider,
                modelOverride: selection.model,
                ...(selection.profile ? { authProfileOverride: selection.profile } : {}),
              };
            }
          }
          generatedDisplayName =
            (await generateDashboardSessionTitle({
              cfg,
              agentId: target.agentId,
              entry: titleModelEntry,
              userMessage: stripInlineDirectiveTagsForDisplay(initialMessage).text,
            })) ?? undefined;
        } catch (error) {
          sessionLog.warn(`worktree title generation failed: ${formatErrorMessage(error)}`);
        }
      }
      sessionWorktree = await managedWorktrees.create({
        repoRoot: workspace,
        ownerKind: "session",
        ownerId: target.canonicalKey,
        name: requestedWorktreeName,
        suggestedName: slugifyWorktreeTitle(
          normalizeOptionalString(p.label) ?? generatedDisplayName ?? "",
        ),
        baseRef: requestedWorktreeBaseRef,
        // Checkout hooks and .openclaw/worktree-setup.sh run repo code; keep them
        // admin-only so this write-scoped path cannot execute gated repo scripts.
        runSetupScript: scopes.includes(ADMIN_SCOPE),
      });
      provisionedSessionWorktree = true;
    }
  } catch (error) {
    if (error instanceof WorktreeRepositoryError) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agent workspace is not a git checkout"),
      );
      return undefined;
    }
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    return undefined;
  }

  // Nested workspaces run from the matching subdirectory inside the worktree, mirroring
  // how the session would have run in the source checkout; the worktree root would
  // silently change tool/file scope for subdirectory-configured agents.
  let sessionCwd = sessionWorktree.path;
  try {
    const relative = path.relative(sessionSourceRoot, fs.realpathSync(workspace));
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      sessionCwd = path.join(sessionWorktree.path, relative);
      fs.mkdirSync(sessionCwd, { recursive: true });
    }
  } catch {
    sessionCwd = sessionWorktree.path;
  }
  return {
    sessionKey,
    sessionAgentId,
    sessionWorktree,
    sessionCwd,
    sessionSourceRoot,
    provisionedSessionWorktree,
  };
}
