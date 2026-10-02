import path from "node:path";
import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import type { KnoxRoomAgentBinding, MainSessionKeyBuilder } from "./contracts.js";
import {
  type AuthenticatedWorkspace,
  type SkillHubStore,
  SkillHubServiceError,
} from "./skill-hub-service-support.js";

export type KnoxSkillHubCommandContext = {
  accountId: string;
  conversationType: "dm" | "room";
  conversationId: string;
  agentId: string;
  sessionKey: string;
};

type CommandWorkspaceStore = Pick<
  SkillHubStore,
  | "getUserByAccountId"
  | "getUserById"
  | "getPersonalAgentBinding"
  | "listAgentBindingsByState"
  | "resolveAuthenticatedKnoxDmRoute"
>;

function workspaceForAgent(workspaceRoot: string, agentId: string): string {
  const root = path.resolve(workspaceRoot);
  const workspaceDir = path.resolve(root, agentId);
  if (
    !isValidAgentId(agentId) ||
    agentId !== agentId.trim() ||
    agentId !== agentId.toLowerCase() ||
    path.dirname(workspaceDir) !== root
  ) {
    throw new SkillHubServiceError("SkillHub Agent workspace is invalid", 500);
  }
  return workspaceDir;
}

export async function resolveKnoxSkillHubWorkspace(params: {
  store: CommandWorkspaceStore;
  workspaceRoot: string;
  senderAccountId: string;
  context: KnoxSkillHubCommandContext;
  buildAgentMainSessionKey: MainSessionKeyBuilder;
}): Promise<AuthenticatedWorkspace> {
  const { context, store } = params;
  if (context.conversationType === "dm") {
    const route = await store.resolveAuthenticatedKnoxDmRoute({
      accountId: params.senderAccountId,
    });
    if (route.status !== "resolved") {
      throw new SkillHubServiceError("linked active employee account required", 401);
    }
    if (
      context.agentId !== route.binding.agentId ||
      context.sessionKey !== route.sessionKey ||
      context.sessionKey !== params.buildAgentMainSessionKey({ agentId: route.binding.agentId })
    ) {
      throw new SkillHubServiceError(
        "SkillHub conversation target changed; retry the command",
        409,
      );
    }
    return {
      user: route.user,
      agentId: route.binding.agentId,
      workspaceDir: workspaceForAgent(params.workspaceRoot, route.binding.agentId),
    };
  }

  const user = await store.getUserByAccountId(params.senderAccountId);
  if (!user || user.status !== "active") {
    throw new SkillHubServiceError("linked active employee account required", 401);
  }
  const roomBinding = (await store.listAgentBindingsByState("active")).find(
    (binding): binding is KnoxRoomAgentBinding =>
      binding.kind === "knox-room" &&
      binding.accountId === context.accountId &&
      binding.roomId === context.conversationId &&
      binding.agentId === context.agentId,
  );
  if (
    !roomBinding ||
    context.sessionKey !== params.buildAgentMainSessionKey({ agentId: roomBinding.agentId })
  ) {
    throw new SkillHubServiceError("active Knox room workspace is unavailable", 409);
  }
  // Employee identity owns registry ACLs; the admitted room binding owns the workspace.
  // Never resolve a room command through the sender's personal Agent or VM.
  return {
    user,
    agentId: roomBinding.agentId,
    workspaceDir: workspaceForAgent(params.workspaceRoot, roomBinding.agentId),
    roomBinding,
  };
}

export async function assertSkillHubWorkspace(
  store: Pick<
    CommandWorkspaceStore,
    "getUserById" | "getPersonalAgentBinding" | "listAgentBindingsByState"
  >,
  actor: AuthenticatedWorkspace,
): Promise<void> {
  const pinned = actor.roomBinding;
  const user = await store.getUserById(actor.user.id);
  if (!user || user.status !== "active") {
    throw new SkillHubServiceError("linked active employee account required", 401);
  }
  if (!pinned) {
    const binding = await store.getPersonalAgentBinding(actor.user.id);
    if (
      !binding ||
      binding.state !== "active" ||
      binding.userId !== actor.user.id ||
      binding.agentId !== actor.agentId
    ) {
      throw new SkillHubServiceError("Personal Agent workspace changed; retry the command", 409);
    }
    return;
  }
  const active = (await store.listAgentBindingsByState("active")).some(
    (binding) =>
      binding.kind === "knox-room" &&
      binding.id === pinned.id &&
      binding.accountId === pinned.accountId &&
      binding.roomId === pinned.roomId &&
      binding.agentId === pinned.agentId &&
      binding.agentId === actor.agentId,
  );
  if (!active) {
    throw new SkillHubServiceError("Knox room workspace changed; retry the command", 409);
  }
}
