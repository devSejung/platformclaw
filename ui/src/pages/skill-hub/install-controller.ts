import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { t } from "../../i18n/index.ts";
import { wasPointerActivation } from "../../lib/pointer-activation.ts";
import {
  installPlatformClawHubSkill,
  loadPlatformClawSkillHubConfig,
  loadPlatformClawWorkspaceSkills,
  PlatformClawSkillHubRequestError,
  type PlatformClawSkillHubConfig,
  type PlatformClawSkillHubMessage,
  type PlatformClawSkillHubWorkspaceSkill,
  type PlatformClawSkillHubWorkspaceInventory,
} from "../../platformclaw/skill-hub.ts";
import { renderSkillHubVersionChange } from "./dialogs.ts";
import {
  skillHubVersionLabel,
  type InstallTarget,
  type PendingVersionChange,
  type SkillHubRef,
} from "./page-support.ts";

type InstallTargetSnapshot = Pick<
  PlatformClawSkillHubWorkspaceInventory,
  "targetId" | "targetRevision" | "targetLabel"
>;
type InstallConfirmation = PendingVersionChange & SkillHubRef & { context: InstallTargetSnapshot };

type InstallState =
  | { status: "checking" }
  | { status: "unavailable"; reason: string }
  | {
      status: "ready";
      context: InstallTargetSnapshot;
      installed?: PlatformClawSkillHubWorkspaceSkill;
      animateCompletion?: true;
    };

const targets = ["platform_server", "assigned_vm"] as const;

export class SkillHubInstallController implements ReactiveController {
  private ref: SkillHubRef | null = null;
  private generation = 0;
  private states: Record<InstallTarget, InstallState> = {
    platform_server: { status: "checking" },
    assigned_vm: { status: "checking" },
  };
  private installing: InstallTarget | null = null;
  private pending: InstallConfirmation | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly setMessage: (message: PlatformClawSkillHubMessage | null) => void,
  ) {
    host.addController(this);
  }

  get busy(): boolean {
    return this.installing !== null;
  }

  hostDisconnected(): void {
    this.clear();
  }

  open(ref: SkillHubRef, config: PlatformClawSkillHubConfig | null): void {
    this.clear();
    this.ref = { id: ref.id, slug: ref.slug };
    for (const target of targets) {
      void this.loadTarget(target, config);
    }
  }

  clear(): void {
    this.generation += 1;
    this.ref = null;
    this.pending = null;
    this.states = { platform_server: { status: "checking" }, assigned_vm: { status: "checking" } };
    this.host.requestUpdate();
  }

  cancelConfirmation(): void {
    if (!this.installing) {
      this.pending = null;
      this.host.requestUpdate();
    }
  }

  private label(target: InstallTarget, targetLabel?: string): string {
    const name = t(
      target === "platform_server" ? "skillHubPage.basicServer" : "skillHubPage.developmentVm",
    );
    return target === "assigned_vm" && targetLabel ? `${name} · ${targetLabel}` : name;
  }

  private async loadTarget(
    target: InstallTarget,
    config?: PlatformClawSkillHubConfig | null,
  ): Promise<void> {
    const generation = this.generation;
    const ref = this.ref;
    if (!ref) {
      return;
    }
    this.states[target] = { status: "checking" };
    this.host.requestUpdate();
    let state: InstallState;
    try {
      const currentConfig = config ?? (await loadPlatformClawSkillHubConfig());
      const availability = currentConfig.installTargets?.find((entry) => entry.target === target);
      if (availability?.available === false || (target === "assigned_vm" && !availability)) {
        state = {
          status: "unavailable",
          reason: t(
            availability?.status === "unassigned" || !availability
              ? "skillHubPage.vmUnassigned"
              : "skillHubPage.vmNotReady",
          ),
        };
      } else {
        const result = await loadPlatformClawWorkspaceSkills(target);
        if (result.source !== target || !Array.isArray(result.items)) {
          throw new Error("Invalid workspace skill status");
        }
        state = {
          status: "ready",
          context: {
            targetId: result.targetId,
            targetRevision: result.targetRevision,
            targetLabel: result.targetLabel,
          },
          installed: result.items.find((item) => item.skillKey === ref.slug),
        };
      }
    } catch {
      state = {
        status: "unavailable",
        reason: t(
          target === "assigned_vm" ? "skillHubPage.vmUnreachable" : "skillHubPage.basicUnreachable",
        ),
      };
    }
    // A closed/replaced detail must never receive an older target's status.
    if (generation === this.generation) {
      this.states[target] = state;
      this.host.requestUpdate();
    }
  }

  render(version: string) {
    return html`<section
      class="skill-hub-destinations"
      aria-label=${t("skillHubPage.downloadLocation")}
    >
      <div>
        <h3>${t("skillHubPage.downloadLocation")}</h3>
        <p>${t("skillHubPage.downloadLocationHelp")}</p>
      </div>
      <div class="skill-hub-install-actions">
        ${targets.map((target) => this.renderTarget(target, version))}
      </div>
    </section>`;
  }

  private renderTarget(target: InstallTarget, version: string) {
    const state = this.states[target];
    const installed = state.status === "ready" ? state.installed : undefined;
    const sameSkill = installed?.hubSkillId === this.ref?.id;
    const sameVersion = Boolean(sameSkill && installed?.version && installed.version === version);
    const unknownVersion = Boolean(installed && !installed.version);
    const blocked =
      state.status !== "ready" ||
      !version ||
      sameVersion ||
      unknownVersion ||
      Boolean(this.installing);
    const status =
      state.status === "checking"
        ? t("skillHubPage.checkingInstallation")
        : state.status === "unavailable"
          ? state.reason
          : installed && !sameSkill
            ? t("skillHubPage.workspaceCollision")
            : installed?.version
              ? t("skillHubPage.installedVersion", {
                  version: skillHubVersionLabel(installed.version),
                })
              : installed
                ? t("skillHubPage.installedVersionUnknown")
                : t("skillHubPage.notInstalled");
    const action =
      this.installing === target
        ? t("skillsPage.skillHub.installing")
        : sameVersion
          ? t("skillHubPage.alreadyInstalled")
          : installed && !sameSkill
            ? t("skillHubPage.replaceLocalCopy")
            : installed
              ? t("skillHubPage.changeToVersion", { version: skillHubVersionLabel(version) })
              : t(
                  target === "platform_server"
                    ? "skillHubPage.installBasic"
                    : "skillHubPage.installVm",
                );
    // Key only status text so completion enters without replacing controls or the live region.
    return html`<article
      class="skill-hub-destination"
      data-install-target=${target}
      aria-busy=${state.status === "checking"}
    >
      <h4>
        ${this.label(target, state.status === "ready" ? state.context.targetLabel : undefined)}
      </h4>
      <p class="skill-hub-destination__description">
        ${t(
          target === "platform_server"
            ? "skillHubPage.basicServerHelp"
            : "skillHubPage.developmentVmHelp",
        )}
      </p>
      <p class="skill-hub-destination__status" role="status">
        ${keyed(
          state,
          html`<span
            class=${state.status === "ready" && state.animateCompletion
              ? "skill-hub-destination__completion"
              : ""}
            >${status}</span
          >`,
        )}
      </p>
      <button
        class="btn ${target === "platform_server" ? "primary" : ""}"
        ?disabled=${blocked}
        @click=${() => void this.install(target, version)}
      >
        ${action}
      </button>
      ${state.status === "unavailable" || (target === "assigned_vm" && state.status === "ready")
        ? html`<button
            class="btn btn--sm"
            ?disabled=${Boolean(this.installing)}
            @click=${() => {
              if (!this.installing && this.states[target].status !== "checking") {
                void this.loadTarget(target);
              }
            }}
          >
            ${t("skillHubPage.checkAgain")}
          </button>`
        : nothing}
    </article>`;
  }

  renderConfirmation() {
    const pending = this.pending;
    return renderSkillHubVersionChange({
      open: pending !== null,
      currentVersion: pending?.currentVersion ?? "",
      requestedVersion: pending?.requestedVersion ?? "",
      direction: pending?.direction ?? "upgrade",
      targetLabel: pending ? this.label(pending.target, pending.context.targetLabel) : undefined,
      busy: this.installing !== null,
      onClose: () => this.cancelConfirmation(),
      onConfirm: () =>
        pending && void this.install(pending.target, pending.requestedVersion, pending),
    });
  }

  private async install(
    target: InstallTarget,
    version: string,
    confirmation?: InstallConfirmation,
  ): Promise<void> {
    const ref = this.ref;
    const state = this.states[target];
    if (
      !ref ||
      !version ||
      this.installing ||
      state.status !== "ready" ||
      (state.installed?.hubSkillId === ref.id && state.installed?.version === version)
    ) {
      return;
    }
    const generation = this.generation;
    // Capture the initiating action before network work; later input may belong to another control.
    const animateCompletion = wasPointerActivation();
    this.installing = target;
    this.setMessage(null);
    this.host.requestUpdate();
    const context = confirmation ? confirmation.context : state.context;
    try {
      const result = await installPlatformClawHubSkill({
        id: ref.id,
        version,
        destination: target,
        ...(context.targetId ? { expectedTargetId: context.targetId } : {}),
        ...(target === "assigned_vm" && context.targetRevision !== undefined
          ? { expectedTargetRevision: context.targetRevision }
          : {}),
        ...(confirmation
          ? {
              acknowledgedReplacement: true as const,
              currentRevision: confirmation.currentRevision,
            }
          : {}),
      });
      if (generation !== this.generation) {
        return;
      }
      this.pending = null;
      this.states[target] = {
        status: "ready",
        context,
        installed: {
          skillKey: result.slug,
          version: result.version,
          hubSkillId: ref.id,
          hubVersion: result.version,
        },
        ...(animateCompletion ? { animateCompletion: true as const } : {}),
      };
      this.setMessage({
        kind: "success",
        text: t("skillHubPage.installed", {
          skill: `${result.slug}@${result.version}`,
          target: this.label(target, context.targetLabel),
        }),
      });
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      const details = error instanceof PlatformClawSkillHubRequestError ? error.details : undefined;
      if (
        details?.code === "existing-skill-replacement-required" &&
        typeof details.currentVersion === "string" &&
        typeof details.currentRevision === "string" &&
        typeof details.requestedVersion === "string" &&
        (details.direction === "upgrade" ||
          details.direction === "downgrade" ||
          details.direction === "reinstall")
      ) {
        this.states[target] = {
          status: "ready",
          context,
          installed: {
            skillKey: ref.slug,
            version: details.currentVersion,
            revision: details.currentRevision,
          },
        };
        // Another tab may have installed this version after our inventory read.
        // Equal version text does not identify a Hub skill or authorize replacement.
        this.pending = {
          ...ref,
          target,
          context,
          currentVersion: details.currentVersion,
          currentRevision: details.currentRevision,
          requestedVersion: details.requestedVersion,
          direction: details.direction,
        };
      } else {
        this.pending = null;
        this.setMessage({
          kind: "error",
          text: error instanceof Error ? error.message : String(error),
        });
        await this.loadTarget(target);
      }
    } finally {
      this.installing = null;
      this.host.requestUpdate();
    }
  }
}
