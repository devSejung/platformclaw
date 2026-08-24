import { state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  loadPlatformClawSkillHubNamespaceBindings,
  loadPlatformClawSkillHubUnassignedSkills,
  removePlatformClawSkillHubNamespaceBinding,
  setPlatformClawSkillHubNamespaceAccessState,
  setPlatformClawSkillHubNamespaceBinding,
  type PlatformClawManagedScope,
  type PlatformClawSkillHubMessage,
  type PlatformClawSkillHubNamespaceBinding,
  type PlatformClawSkillHubUnassignedSkill,
} from "../../platformclaw/skill-hub.ts";
import type { SkillHubAdminAction, SkillHubAdminDraft } from "./admin.ts";

export abstract class SkillHubAdminController extends OpenClawLightDomElement {
  @state() protected error: string | null = null;
  @state() protected message: PlatformClawSkillHubMessage | null = null;
  @state() protected adminOpen = false;
  @state() protected adminLoading = false;
  @state() protected adminBusy = false;
  @state() protected namespaceBindings: PlatformClawSkillHubNamespaceBinding[] = [];
  @state() protected managedScopes: PlatformClawManagedScope[] = [];
  @state() protected unassignedSkills: PlatformClawSkillHubUnassignedSkill[] = [];
  @state() protected adminDraft: SkillHubAdminDraft = {
    namespace: "",
    scopeKind: "global",
    scopeId: "",
    visibilityCeiling: "NAMESPACE_ONLY",
    reason: "",
  };
  @state() protected pendingAdminAction: SkillHubAdminAction | null = null;

  protected async openAdmin() {
    this.adminOpen = true;
    this.adminLoading = true;
    try {
      const [namespaceResult, unassignedResult] = await Promise.all([
        loadPlatformClawSkillHubNamespaceBindings(),
        loadPlatformClawSkillHubUnassignedSkills(),
      ]);
      this.namespaceBindings = namespaceResult.bindings;
      this.managedScopes = namespaceResult.scopes;
      this.unassignedSkills = unassignedResult.items;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.adminLoading = false;
    }
  }

  protected async saveNamespaceBinding() {
    if (this.adminBusy) {
      return;
    }
    this.adminBusy = true;
    try {
      const current = this.namespaceBindings.find(
        (binding) => binding.namespace === this.adminDraft.namespace.trim().toLowerCase(),
      );
      await setPlatformClawSkillHubNamespaceBinding({
        namespace: this.adminDraft.namespace,
        scopeKind: this.adminDraft.scopeKind,
        ...(this.adminDraft.scopeKind === "global" ? {} : { scopeId: this.adminDraft.scopeId }),
        visibilityCeiling: this.adminDraft.visibilityCeiling,
        expectedUpdatedAt: current?.updatedAt ?? null,
        reason: this.adminDraft.reason,
      });
      await this.openAdmin();
      this.message = { kind: "success", text: t("skillHubPage.bindingSaved") };
    } catch (error) {
      this.message = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.adminBusy = false;
    }
  }

  private async setNamespaceAccessState(
    binding: PlatformClawSkillHubNamespaceBinding,
    accessState: "active" | "restricted",
    reason: string,
  ) {
    if (this.adminBusy) {
      return;
    }
    this.adminBusy = true;
    try {
      await setPlatformClawSkillHubNamespaceAccessState(binding.namespace, {
        accessState,
        expectedUpdatedAt: binding.updatedAt,
        reason,
      });
      await this.openAdmin();
      this.message = { kind: "success", text: t("skillHubPage.bindingSaved") };
    } catch (error) {
      this.message = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.adminBusy = false;
    }
  }

  private async removeNamespaceBinding(
    binding: PlatformClawSkillHubNamespaceBinding,
    reason: string,
  ) {
    if (this.adminBusy) {
      return;
    }
    this.adminBusy = true;
    try {
      await removePlatformClawSkillHubNamespaceBinding(binding.namespace, {
        expectedUpdatedAt: binding.updatedAt,
        reason,
      });
      await this.openAdmin();
      this.message = { kind: "success", text: t("skillHubPage.bindingRemoved") };
    } catch (error) {
      this.message = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.adminBusy = false;
    }
  }

  protected async confirmAdminAction() {
    const pending = this.pendingAdminAction;
    if (!pending?.reason.trim()) {
      return;
    }
    this.pendingAdminAction = null;
    if (pending.action === "remove") {
      await this.removeNamespaceBinding(pending.binding, pending.reason);
      return;
    }
    await this.setNamespaceAccessState(
      pending.binding,
      pending.action === "activate" ? "active" : "restricted",
      pending.reason,
    );
  }
}
