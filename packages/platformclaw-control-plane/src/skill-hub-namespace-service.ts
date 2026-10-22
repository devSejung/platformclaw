import { randomUUID } from "node:crypto";
import type { PlatformUser } from "./contracts.js";
import { SkillHubEditService } from "./skill-hub-edit-service.js";
import { SkillHubGovernanceError } from "./skill-hub-governance-client.js";
import {
  DEFAULT_SKILL_HUB_NAMESPACE,
  resolveSkillHubScopeCapabilities,
} from "./skill-hub-organization-policy.js";
import { SkillHubServiceError } from "./skill-hub-service-support.js";
import type { SkillHubNamespaceBinding } from "./skill-hub-state.js";

// Native namespace creation accepts 2–64 characters and rejects double hyphens.
// Keep the employee-facing slug subset portable across registry deployments.
const CREATION_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/u;

export abstract class SkillHubNamespaceService extends SkillHubEditService {
  private readonly namespaceCreationsInFlight = new Set<string>();

  async namespaceCreationOptions(user: PlatformUser) {
    if (user.status !== "active") {
      throw new SkillHubServiceError("active PlatformClaw user required", 403);
    }
    if (!this.options.governance?.createNamespace) {
      throw new SkillHubServiceError("Skill Hub namespace creation is unavailable", 503);
    }
    const scopes: Array<{
      scopeKind: SkillHubNamespaceBinding["scopeKind"];
      scopeId?: string;
      scopeName?: string;
    }> = [{ scopeKind: "global" }];
    for (const scope of await this.options.organization.listScopes()) {
      const authorization = await this.options.organization.authorization.authorizeManagedScope(
        user.id,
        scope.id,
      );
      if (
        resolveSkillHubScopeCapabilities({
          user,
          scopeKind: scope.kind,
          scopeId: scope.id,
          organizationAuthorization: authorization,
        }).canPublish
      ) {
        scopes.push({ scopeKind: scope.kind, scopeId: scope.id, scopeName: scope.name });
      }
    }
    scopes.splice(
      1,
      scopes.length - 1,
      ...scopes
        .slice(1)
        .toSorted(
          (a, b) =>
            a.scopeName!.localeCompare(b.scopeName!) || a.scopeId!.localeCompare(b.scopeId!),
        ),
    );
    const creations = await this.options.store.listSkillHubNamespaceCreations(user.id);
    return {
      scopes,
      creations: creations.map((creation) =>
        Object.assign(
          {
            namespace: creation.namespace,
            state: creation.state,
            scopeKind: creation.scopeKind,
            updatedAt: creation.updatedAt,
          },
          creation.scopeId ? { scopeId: creation.scopeId } : {},
        ),
      ),
    };
  }

  async createNamespace(
    user: PlatformUser,
    params: {
      namespace: string;
      scopeKind: SkillHubNamespaceBinding["scopeKind"];
      scopeId?: string;
    },
  ) {
    const governance = this.options.governance;
    if (!governance?.createNamespace) {
      throw new SkillHubServiceError("Skill Hub namespace creation is unavailable", 503);
    }
    const namespace = params.namespace.trim().toLowerCase();
    if (!CREATION_NAMESPACE_PATTERN.test(namespace) || namespace.includes("--")) {
      throw new SkillHubServiceError(
        "Choose a valid unused namespace with 2–64 lowercase letters, digits, or hyphens",
        400,
        { code: "skill-hub-namespace-invalid" },
      );
    }
    if (
      namespace === DEFAULT_SKILL_HUB_NAMESPACE ||
      this.options.allowedNamespaces.some((value) => value.trim().toLowerCase() === namespace)
    ) {
      throw new SkillHubServiceError("Namespace is reserved by the deployment configuration", 409, {
        code: "skill-hub-namespace-conflict",
      });
    }
    if (this.namespaceCreationsInFlight.has(namespace)) {
      throw new SkillHubServiceError("Namespace creation is in progress; reload its status", 409, {
        code: "skill-hub-namespace-in-progress",
      });
    }
    this.namespaceCreationsInFlight.add(namespace);
    try {
      await this.initializeNamespaces(user);
      const creation = await this.options.store.beginSkillHubNamespaceCreation({
        namespace,
        operationId: randomUUID(),
        actorUserId: user.id,
        scopeKind: params.scopeKind,
        ...(params.scopeId ? { scopeId: params.scopeId.trim() } : {}),
        changedAt: this.now(),
      });
      if (creation.state === "completed") {
        const binding = await this.options.store.getSkillHubNamespaceBinding(namespace);
        if (!binding) {
          throw new SkillHubServiceError("Namespace binding changed; reload its status", 409, {
            code: "skill-hub-namespace-conflict",
          });
        }
        this.namespaces.add(namespace);
        return projectSkillHubNamespaceBinding(binding);
      }
      let registry: { id: number; namespace: string };
      try {
        registry = await governance.createNamespace({
          namespace,
          operationId: creation.operationId,
        });
        if (
          !Number.isSafeInteger(registry.id) ||
          registry.id < 1 ||
          registry.namespace !== namespace ||
          (creation.registryNamespaceId !== undefined &&
            registry.id !== creation.registryNamespaceId)
        ) {
          throw new SkillHubGovernanceError("Skill Hub namespace identity changed", 409);
        }
      } catch (error) {
        const status = error instanceof SkillHubGovernanceError ? error.statusCode : undefined;
        await this.options.store.recordSkillHubNamespaceCreation({
          namespace,
          operationId: creation.operationId,
          state: status === 400 || status === 409 ? "failed" : "uncertain",
          changedAt: this.now(),
        });
        if (status === 400) {
          throw new SkillHubServiceError(
            "Registry rejected this namespace; choose another valid unused name",
            400,
            { code: "skill-hub-namespace-invalid" },
          );
        }
        const code = status === 409 ? "skill-hub-namespace-conflict" : "skill-hub-namespace-retry";
        throw new SkillHubServiceError(
          status === 409
            ? "Namespace already exists and cannot be adopted"
            : "Namespace creation could not be confirmed; retry the same name and scope",
          status === 409 ? 409 : 503,
          { code },
        );
      }
      // Persist the registry's identity before activation. A lost response or
      // membership change resumes only this exact durable operation on explicit retry.
      await this.options.store.recordSkillHubNamespaceCreation({
        namespace,
        operationId: creation.operationId,
        state: "registry-created",
        registryNamespaceId: registry.id,
        changedAt: this.now(),
      });
      const binding = await this.options.store.completeSkillHubNamespaceCreation({
        namespace,
        operationId: creation.operationId,
        changedAt: this.now(),
      });
      this.namespaces.add(namespace);
      return projectSkillHubNamespaceBinding(binding);
    } finally {
      this.namespaceCreationsInFlight.delete(namespace);
    }
  }
}

export function projectSkillHubNamespaceBinding(binding: SkillHubNamespaceBinding) {
  return Object.assign(
    {
      namespace: binding.namespace,
      scopeKind: binding.scopeKind,
      accessState: binding.accessState,
      visibilityCeiling: binding.visibilityCeiling,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    },
    binding.scopeId ? { scopeId: binding.scopeId } : {},
  );
}
