import { html, nothing } from "lit";
import { renderHubTabs } from "../components/hub-tabs.ts";
import { renderSettingsSection } from "../components/settings-ui.ts";
import { platformClawT as t } from "./i18n.ts";
import type {
  OrganizationJoinRequestDetail,
  OrganizationReviewRequestDetail,
  OrganizationScopeResult,
} from "./organization-api.ts";

export type OrganizationJoinSection = "mine" | "review";

function lineageLabel(lineage: Array<{ name: string }>): string {
  return lineage.map((scope) => scope.name).join(" / ");
}

function requestStatus(detail: OrganizationJoinRequestDetail) {
  return html`<span class="badge"
    >${t(`platformClaw.organization.join.status.${detail.request.status}`)}</span
  >`;
}

function renderBrowse(props: {
  scopes: OrganizationScopeResult[];
  hasMore: boolean;
  busy: boolean;
  onSearch(query: string): void;
  onRequest(scope: OrganizationScopeResult): void;
}) {
  return renderSettingsSection(
    {
      title: t("platformClaw.organization.join.browse.title"),
      description: t("platformClaw.organization.join.browse.description"),
    },
    html`<form
        class="organization-search"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const form = event.currentTarget as HTMLFormElement;
          props.onSearch(String(new FormData(form).get("query") ?? ""));
        }}
      >
        <label>
          <span>${t("platformClaw.organization.join.browse.search")}</span>
          <input name="query" maxlength="128" />
        </label>
        <button class="btn" type="submit" ?disabled=${props.busy}>
          ${t("platformClaw.organization.search")}
        </button>
      </form>
      ${props.scopes.length === 0
        ? html`<p class="muted">${t("platformClaw.organization.join.browse.empty")}</p>`
        : html`<ul class="organization-request-list">
            ${props.scopes.map(
              (scope) => html`<li>
                <div>
                  <strong>${lineageLabel(scope.lineage)}</strong>
                  <span class="muted">${t(`platformClaw.organization.kind.${scope.kind}`)}</span>
                  ${scope.requestState === "eligible"
                    ? nothing
                    : html`<p class="muted">
                        ${t(`platformClaw.organization.join.state.${scope.requestState}`)}
                      </p>`}
                </div>
                <button
                  class="btn primary"
                  type="button"
                  ?disabled=${props.busy || scope.requestState !== "eligible"}
                  @click=${() => props.onRequest(scope)}
                >
                  ${t("platformClaw.organization.join.request")}
                </button>
              </li>`,
            )}
          </ul>`}
      ${props.hasMore
        ? html`<p class="muted">${t("platformClaw.organization.join.refine")}</p>`
        : nothing}`,
  );
}

function renderMine(props: {
  items: OrganizationJoinRequestDetail[];
  nextOffset?: number;
  busy: boolean;
  onCancel(item: OrganizationJoinRequestDetail): void;
  onMore(offset: number): void;
}) {
  return renderSettingsSection(
    {
      title: t("platformClaw.organization.join.mine.title"),
      description: t("platformClaw.organization.join.mine.description"),
    },
    props.items.length === 0
      ? html`<p class="muted">${t("platformClaw.organization.join.mine.empty")}</p>`
      : html`<ul class="organization-request-list">
            ${props.items.map(
              (item) => html`<li>
                <div>
                  <strong>${lineageLabel(item.lineage)}</strong>
                  ${requestStatus(item)}
                  <p>${item.request.reason}</p>
                  ${item.request.decisionReason
                    ? html`<p class="muted">${item.request.decisionReason}</p>`
                    : nothing}
                </div>
                ${item.request.status === "pending"
                  ? html`<button
                      class="btn"
                      type="button"
                      ?disabled=${props.busy}
                      @click=${() => props.onCancel(item)}
                    >
                      ${t("platformClaw.organization.join.cancel")}
                    </button>`
                  : nothing}
              </li>`,
            )}
          </ul>
          ${props.nextOffset === undefined
            ? nothing
            : html`<button
                class="btn"
                type="button"
                ?disabled=${props.busy}
                @click=${() => props.onMore(props.nextOffset!)}
              >
                ${t("platformClaw.organization.join.more")}
              </button>`}`,
  );
}

function renderReview(props: {
  items: OrganizationReviewRequestDetail[];
  nextOffset?: number;
  busy: boolean;
  onDecision(item: OrganizationReviewRequestDetail, decision: "approved" | "rejected"): void;
  onMore(offset: number): void;
}) {
  return renderSettingsSection(
    {
      title: t("platformClaw.organization.join.review.title"),
      description: t("platformClaw.organization.join.review.description"),
    },
    props.items.length === 0
      ? html`<p class="muted">${t("platformClaw.organization.join.review.empty")}</p>`
      : html`<ul class="organization-request-list">
            ${props.items.map(
              (item) => html`<li>
                <div>
                  <strong>${item.applicant.displayName ?? item.applicant.accountId}</strong>
                  <span class="muted">${lineageLabel(item.lineage)}</span>
                  <p>${item.request.reason}</p>
                </div>
                <div class="organization-request-actions">
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${props.busy}
                    @click=${() => props.onDecision(item, "rejected")}
                  >
                    ${t("platformClaw.organization.join.reject")}
                  </button>
                  <button
                    class="btn primary"
                    type="button"
                    ?disabled=${props.busy}
                    @click=${() => props.onDecision(item, "approved")}
                  >
                    ${t("platformClaw.organization.join.approve")}
                  </button>
                </div>
              </li>`,
            )}
          </ul>
          ${props.nextOffset === undefined
            ? nothing
            : html`<button
                class="btn"
                type="button"
                ?disabled=${props.busy}
                @click=${() => props.onMore(props.nextOffset!)}
              >
                ${t("platformClaw.organization.join.more")}
              </button>`}`,
  );
}

export function renderOrganizationJoin(props: {
  active: OrganizationJoinSection;
  scopes: OrganizationScopeResult[];
  scopesHasMore: boolean;
  own: OrganizationJoinRequestDetail[];
  ownNextOffset?: number;
  reviewable: OrganizationReviewRequestDetail[];
  reviewNextOffset?: number;
  canReview: boolean;
  busy: boolean;
  onSelect(section: OrganizationJoinSection): void;
  onSearch(query: string): void;
  onRequest(scope: OrganizationScopeResult): void;
  onCancel(item: OrganizationJoinRequestDetail): void;
  onDecision(item: OrganizationReviewRequestDetail, decision: "approved" | "rejected"): void;
  onMoreOwn(offset: number): void;
  onMoreReview(offset: number): void;
}) {
  return html`${renderHubTabs({
      id: "platformclaw-organization-join",
      active: props.active,
      tabs: [
        { value: "mine", label: t("platformClaw.organization.join.tabs.mine") },
        ...(props.canReview
          ? [{ value: "review" as const, label: t("platformClaw.organization.join.tabs.review") }]
          : []),
      ],
      ariaLabel: t("platformClaw.organization.join.tabs.label"),
      panelId: "platformclaw-organization-join-panel",
      onSelect: props.onSelect,
    })}
    <section id="platformclaw-organization-join-panel">
      ${props.active === "mine"
        ? html`${renderBrowse({
            scopes: props.scopes,
            hasMore: props.scopesHasMore,
            busy: props.busy,
            onSearch: props.onSearch,
            onRequest: props.onRequest,
          })}${renderMine({
            items: props.own,
            nextOffset: props.ownNextOffset,
            busy: props.busy,
            onCancel: props.onCancel,
            onMore: props.onMoreOwn,
          })}`
        : renderReview({
            items: props.reviewable,
            nextOffset: props.reviewNextOffset,
            busy: props.busy,
            onDecision: props.onDecision,
            onMore: props.onMoreReview,
          })}
    </section>`;
}
