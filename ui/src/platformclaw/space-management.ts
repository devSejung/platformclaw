import { html, nothing } from "lit";
import type {
  Space,
  SpaceConversation,
} from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import "../components/modal-dialog.ts";
import { platformClawT } from "./i18n.ts";
import { spaceGatewayErrorMessage } from "./space-gateway-request.ts";

const t = (key: string) => platformClawT(`platformClaw.spaces.${key}`);
type SpaceManagementAction =
  | { kind: "rename"; space: Space; conversation: SpaceConversation }
  | { kind: "delete" | "leave"; space: Space };

/** Pins confirmation to its original target and revision, even during revalidation. */
export class SpaceManagementState {
  pending: SpaceManagementAction | null = null;
  busy = false;
  error = "";
  constructor(private readonly changed: () => void) {}

  open(action: SpaceManagementAction) {
    if (this.busy) {
      return;
    }
    this.pending = action;
    this.error = "";
    this.changed();
  }

  openFor(
    kind: SpaceManagementAction["kind"],
    options: {
      space: Space | undefined;
      conversation: SpaceConversation | null;
      currentUserId: string | undefined;
      disabled: boolean;
    },
  ) {
    const { space, conversation } = options;
    if (options.disabled || !space) {
      return;
    }
    if (kind === "rename") {
      if (conversation?.canWrite && conversation.ownerId === options.currentUserId) {
        this.open({ kind, space, conversation });
      }
    } else if (kind !== "delete" || space.role === "owner") {
      this.open({ kind, space });
    }
  }

  revalidate(space: Space, conversations: SpaceConversation[]) {
    const pending = this.pending;
    if (
      pending &&
      ((pending.kind === "delete" && space.role !== "owner") ||
        (pending.kind === "rename" &&
          !conversations.some((item) => item.id === pending.conversation.id && item.canWrite)))
    ) {
      this.clear();
    }
  }

  clear() {
    if (!this.pending && !this.error) {
      return;
    }
    this.pending = null;
    this.error = "";
    this.changed();
  }

  async submit(
    value: string,
    request: <T>(method: string, params: Record<string, unknown>) => Promise<T>,
    completed: (action: SpaceManagementAction, conversation?: SpaceConversation) => void,
  ) {
    const action = this.pending;
    if (
      !action ||
      this.busy ||
      (action.kind === "rename" && !value.trim()) ||
      (action.kind === "delete" && value !== action.space.name)
    ) {
      return;
    }
    this.busy = true;
    this.error = "";
    this.changed();
    try {
      const params = { spaceId: action.space.id, expectedRevision: action.space.revision };
      const conversation =
        action.kind === "rename"
          ? await request<SpaceConversation>("conversation.rename", {
              ...params,
              conversationId: action.conversation.id,
              expectedTitle: action.conversation.title,
              title: value.trim(),
            })
          : undefined;
      if (action.kind !== "rename") {
        await request(action.kind, {
          ...params,
          ...(action.kind === "delete" ? { confirmName: value } : {}),
        });
      }
      // Navigation, disconnection, and dismissal invalidate the captured confirmation.
      if (this.pending === action) {
        this.clear();
        completed(action, conversation);
        return "completed";
      }
    } catch (error) {
      if (this.pending === action) {
        this.error = spaceGatewayErrorMessage(error);
        return "failed";
      }
    } finally {
      this.busy = false;
      this.changed();
    }
    return undefined;
  }
}

export function renderSpaceManagementDialog(options: {
  state: SpaceManagementState;
  onSubmit: (title: string) => void;
}) {
  const state = options.state;
  const action = state.pending;
  if (!action) {
    return nothing;
  }
  const label = t(action.kind === "rename" ? "renameConversation" : `${action.kind}Space`);
  return html`<openclaw-modal-dialog
    label=${label}
    description=${action.space.name}
    @modal-cancel=${(event: Event) => {
      if (state.busy) {
        event.preventDefault();
      } else {
        state.clear();
      }
    }}
    @keydown=${(event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
      }
    }}
  >
    <form
      class="pc-space-management-dialog exec-approval-card"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const field = (event.currentTarget as HTMLFormElement).querySelector<HTMLInputElement>(
          "input",
        );
        if (field) {
          if (action.kind === "rename") {
            field.value = field.value.trim();
          }
          field.setCustomValidity(
            action.kind === "delete" && field.value !== action.space.name
              ? t("confirmSpaceNameMismatch")
              : "",
          );
          if (!field.reportValidity()) {
            return;
          }
        }
        options.onSubmit(field?.value ?? "");
      }}
    >
      <h2>${label}</h2>
      <p>${action.space.name}</p>
      ${action.kind === "rename"
        ? html`<label class="field"
            ><span>${t("name")}</span>
            <input
              name="title"
              required
              maxlength="240"
              autofocus
              ?disabled=${state.busy}
              .value=${action.conversation.title}
            />
          </label>`
        : html`<p>${t(`${action.kind}SpaceNotice`)}</p>
            ${action.kind === "leave" && action.space.role === "owner"
              ? html`<p>${t("lastOwnerNotice")}</p>`
              : nothing}
            ${action.kind === "delete"
              ? html`<label class="field"
                  ><span>${t("confirmSpaceName")}</span>
                  <input
                    name="confirmName"
                    required
                    autocomplete="off"
                    ?disabled=${state.busy}
                    @input=${(event: Event) =>
                      (event.target as HTMLInputElement).setCustomValidity("")}
                  />
                </label>`
              : nothing}`}
      ${state.error
        ? html`<p role="alert">${state.error}</p>
            <p>${t(action.kind === "leave" ? "leaveRetryHint" : "managementRetryHint")}</p>`
        : nothing}
      <div class="exec-approval-actions">
        <button
          type="button"
          class="btn"
          ?autofocus=${action.kind !== "rename"}
          ?disabled=${state.busy}
          @click=${() => state.clear()}
        >
          ${t("cancel")}
        </button>
        <button
          type="submit"
          class="btn ${action.kind === "delete" ? "danger" : "primary"}"
          ?disabled=${state.busy}
        >
          ${action.kind === "rename" ? t("save") : label}
        </button>
      </div>
    </form>
  </openclaw-modal-dialog>`;
}
