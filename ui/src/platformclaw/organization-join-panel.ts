import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { platformClawT as t } from "./i18n.ts";
import {
  PlatformClawOrganizationApi,
  PlatformClawOrganizationApiError,
  type OrganizationJoinRequestDetail,
  type OrganizationReviewRequestDetail,
  type OrganizationScopeResult,
} from "./organization-api.ts";
import { organizationErrorMessage } from "./organization-errors.ts";
import {
  renderOrganizationJoinDialog,
  type OrganizationJoinAction,
} from "./organization-join-dialog.ts";
import { renderOrganizationJoin, type OrganizationJoinSection } from "./organization-join-view.ts";

class PlatformClawOrganizationJoinPanel extends OpenClawLightDomElement {
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => {};
  @state() private section: OrganizationJoinSection = "mine";
  @state() private scopes: OrganizationScopeResult[] = [];
  @state() private scopesHasMore = false;
  @state() private own: OrganizationJoinRequestDetail[] = [];
  @state() private ownNextOffset: number | undefined;
  @state() private reviewable: OrganizationReviewRequestDetail[] = [];
  @state() private reviewNextOffset: number | undefined;
  @state() private canReview = false;
  @state() private pending: OrganizationJoinAction | null = null;
  @state() private busy = false;
  @state() private error = "";
  @state() private notice = "";
  @state() private loading = true;
  private loadEpoch = 0;
  private searchEpoch = 0;

  private get api() {
    return new PlatformClawOrganizationApi({
      fetchImpl: this.fetchImpl,
      onUnauthenticated: this.onUnauthenticated,
    });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.refresh()
      .catch((error: unknown) => {
        this.error = organizationErrorMessage(error, false);
      })
      .finally(() => {
        this.loading = false;
      });
  }

  private async refresh(): Promise<void> {
    const epoch = ++this.loadEpoch;
    this.searchEpoch += 1;
    const [context, scopes, own] = await Promise.all([
      this.api.context(),
      this.api.scopes(),
      this.api.ownRequests(),
    ]);
    const reviewable = context.canReviewJoinRequests
      ? await this.api.reviewableRequests()
      : { items: [] };
    if (epoch !== this.loadEpoch) {
      return;
    }
    this.scopes = scopes.items;
    this.scopesHasMore = scopes.hasMore;
    this.own = own.items;
    this.ownNextOffset = own.nextOffset;
    this.reviewable = reviewable.items;
    this.reviewNextOffset = reviewable.nextOffset;
    this.canReview = context.canReviewJoinRequests;
    if (!this.canReview) {
      this.section = "mine";
    }
  }

  private retry(): void {
    this.loading = true;
    this.error = "";
    void this.refresh()
      .catch((error: unknown) => {
        this.error = organizationErrorMessage(error, false);
      })
      .finally(() => {
        this.loading = false;
      });
  }

  private search(query: string): void {
    if (this.busy) {
      return;
    }
    const epoch = ++this.searchEpoch;
    void this.api
      .scopes(query)
      .then((result) => {
        if (epoch === this.searchEpoch) {
          this.scopes = result.items;
          this.scopesHasMore = result.hasMore;
          this.error = "";
        }
      })
      .catch((error: unknown) => {
        if (epoch === this.searchEpoch) {
          this.error = organizationErrorMessage(error, false);
        }
      });
  }

  private loadMore(kind: "own" | "review", offset: number): void {
    if (this.busy) {
      return;
    }
    const epoch = this.loadEpoch;
    const request =
      kind === "own" ? this.api.ownRequests(offset) : this.api.reviewableRequests(offset);
    this.busy = true;
    void request
      .then((page) => {
        if (epoch !== this.loadEpoch) {
          return;
        }
        if (kind === "own") {
          this.own = this.mergeRequests(this.own, page.items as OrganizationJoinRequestDetail[]);
          this.ownNextOffset = page.nextOffset;
        } else {
          this.reviewable = this.mergeRequests(
            this.reviewable,
            page.items as OrganizationReviewRequestDetail[],
          );
          this.reviewNextOffset = page.nextOffset;
        }
      })
      .catch((error: unknown) => {
        this.error = organizationErrorMessage(error, false);
      })
      .finally(() => {
        this.busy = false;
      });
  }

  private mergeRequests<T extends { request: { id: string } }>(current: T[], next: T[]): T[] {
    const byId = new Map(current.map((item) => [item.request.id, item]));
    for (const item of next) {
      byId.set(item.request.id, item);
    }
    return [...byId.values()];
  }

  private async submit(reason: string): Promise<void> {
    const action = this.pending;
    if (!action || this.busy) {
      return;
    }
    this.busy = true;
    this.error = "";
    try {
      if (action.kind === "request") {
        await this.api.requestMembership(action.id, reason);
      } else if (action.kind === "cancel") {
        await this.api.cancelRequest(action.id, reason);
      } else {
        await this.api.decideRequest(
          action.id,
          action.kind === "approve" ? "approved" : "rejected",
          reason,
        );
      }
      this.pending = null;
      this.notice = t("platformClaw.organization.join.saved");
      try {
        await this.refresh();
      } catch {
        this.notice = t("platformClaw.organization.savedReloadFailed");
      }
    } catch (error) {
      if (error instanceof PlatformClawOrganizationApiError && error.status === 400) {
        this.error = organizationErrorMessage(error, false);
        await this.updateComplete;
        this.querySelector<HTMLElement>(".organization-action-error")?.focus();
      } else {
        try {
          await this.refresh();
          this.pending = null;
          if (
            error instanceof PlatformClawOrganizationApiError &&
            (error.status === 403 || error.status === 404)
          ) {
            this.error = organizationErrorMessage(error, false);
          } else {
            this.notice = t("platformClaw.organization.join.stateChanged");
          }
        } catch {
          this.pending = null;
          this.error = t("platformClaw.organization.join.outcomeUnknownReloadFailed");
        }
      }
    } finally {
      this.busy = false;
    }
  }

  override render() {
    if (this.loading) {
      return html`<p role="status">${t("platformClaw.organization.loading")}</p>`;
    }
    return html`${this.error
      ? html`<div class="callout danger" role="alert">
          <span>${this.error}</span>
          <button class="btn" type="button" @click=${() => this.retry()}>
            ${t("platformClaw.organization.join.retry")}
          </button>
        </div>`
      : nothing}${this.notice
      ? html`<div class="callout" role="status">${this.notice}</div>`
      : nothing}${renderOrganizationJoin({
      active: this.section,
      scopes: this.scopes,
      scopesHasMore: this.scopesHasMore,
      own: this.own,
      ownNextOffset: this.ownNextOffset,
      reviewable: this.reviewable,
      reviewNextOffset: this.reviewNextOffset,
      canReview: this.canReview,
      busy: this.busy,
      onSelect: (section) => {
        this.section = section;
      },
      onSearch: (query) => this.search(query),
      onRequest: (scope) => {
        this.pending = {
          kind: "request",
          id: scope.id,
          target: scope.lineage.map((item) => item.name).join(" / "),
        };
      },
      onCancel: (item) => {
        this.pending = {
          kind: "cancel",
          id: item.request.id,
          target: item.lineage.map((scope) => scope.name).join(" / "),
        };
      },
      onDecision: (item, decision) => {
        this.pending = {
          kind: decision === "approved" ? "approve" : "reject",
          id: item.request.id,
          target: `${item.applicant.displayName ?? item.applicant.accountId} · ${item.lineage
            .map((scope) => scope.name)
            .join(" / ")}`,
        };
      },
      onMoreOwn: (offset) => this.loadMore("own", offset),
      onMoreReview: (offset) => this.loadMore("review", offset),
    })}${renderOrganizationJoinDialog({
      action: this.pending,
      busy: this.busy,
      error: this.error,
      onCancel: () => {
        this.pending = null;
      },
      onSubmit: (reason) => void this.submit(reason),
    })}`;
  }
}

if (!customElements.get("platformclaw-organization-join-panel")) {
  customElements.define("platformclaw-organization-join-panel", PlatformClawOrganizationJoinPanel);
}
