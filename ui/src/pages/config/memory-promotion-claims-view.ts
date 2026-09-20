import { html, nothing } from "lit";
import type {
  OrganizationMemoryClaim,
  OrganizationMemoryLifecycleSnapshot,
} from "../../../../packages/platformclaw-control-plane/src/contracts.js";
import { formatMs, formatRelativeTimestamp } from "../../lib/format.ts";
import { platformClawT as t } from "../../platformclaw/i18n.ts";
import { promotionStatusLabel } from "./memory-promotion-review.ts";

function scopeKey(claim: OrganizationMemoryClaim): string {
  return `${claim.scopeKind}:${claim.scopeId ?? "global"}`;
}

function isReadableClaim(
  claim: OrganizationMemoryClaim,
  scopes: OrganizationMemoryLifecycleSnapshot["scopes"],
): boolean {
  return scopes.some(
    (scope) =>
      scope.canRead &&
      scope.kind === claim.scopeKind &&
      (scope.id ?? "global") === (claim.scopeId ?? "global"),
  );
}

function readableClaimText(
  claim: OrganizationMemoryClaim,
  scopes: OrganizationMemoryLifecycleSnapshot["scopes"],
) {
  // Lifecycle also includes administered-but-unreadable claims for retirement.
  // Keep those metadata/actions without exposing their body via snippets or search.
  return claim.status === "active" && isReadableClaim(claim, scopes) ? claim.text : "";
}

export function renderPromotionClaimsBrowser(props: {
  snapshot: OrganizationMemoryLifecycleSnapshot;
  query: string;
  scope: string;
  connected: boolean;
  getAdvertised: boolean;
  loading: boolean;
  onQueryChange: (query: string) => void;
  onScopeChange: (scope: string) => void;
  onOpen: (path: string) => void;
  onRetire: (claimId: string, purge: boolean) => void;
  onLoadMore: () => void;
}) {
  const claims = props.snapshot.claims;
  const normalizedQuery = props.query.trim().toLocaleLowerCase();
  const scopeOptions = [
    ...new Map(
      claims.map(
        (claim) => [scopeKey(claim), { key: scopeKey(claim), name: claim.scopeName }] as const,
      ),
    ).values(),
  ].toSorted((left, right) => left.name.localeCompare(right.name));
  const filtered = claims.filter((claim) => {
    if (props.scope && scopeKey(claim) !== props.scope) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    return `${claim.title}\n${readableClaimText(claim, props.snapshot.scopes)}\n${claim.scopeName}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
  const claimsHaveMore = props.snapshot.next?.claims !== undefined;

  return html`<section class="settings-section memory-promotions__claims-browser">
    <header class="settings-section__header memory-promotions__claims-header">
      <div>
        <h3 class="settings-section__heading">${t("memoryPage.promotions.claims")}</h3>
        <p class="settings-section__description">${t("memoryPage.promotions.claimsDescription")}</p>
      </div>
      <span class="memory-promotions__claims-count" aria-live="polite">
        ${t("memoryPage.promotions.claimsLoadedCount", {
          visible: String(filtered.length),
          loaded: String(claims.length),
        })}
        ${claimsHaveMore ? ` · ${t("memoryPage.promotions.claimsMoreAvailable")}` : nothing}
      </span>
    </header>
    <div class="memory-promotions__claims-toolbar">
      <label>
        <span>${t("memoryPage.promotions.claimsSearch")}</span>
        <input
          class="settings-input"
          type="search"
          .value=${props.query}
          placeholder=${t("memoryPage.promotions.claimsSearchPlaceholder")}
          @input=${(event: InputEvent) =>
            props.onQueryChange((event.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <label>
        <span>${t("memoryPage.promotions.scope")}</span>
        <select
          class="settings-select"
          .value=${props.scope}
          @change=${(event: Event) =>
            props.onScopeChange((event.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">${t("memoryPage.promotions.claimsAllScopes")}</option>
          ${scopeOptions.map((scope) => html`<option value=${scope.key}>${scope.name}</option>`)}
        </select>
      </label>
    </div>
    <div
      class="settings-group memory-promotions__claims-list"
      role="region"
      tabindex="0"
      aria-label=${t("memoryPage.promotions.claims")}
    >
      ${filtered.length > 0
        ? filtered.map((claim) => {
            const body = readableClaimText(claim, props.snapshot.scopes);
            const readable =
              claim.status === "active" &&
              props.connected &&
              props.getAdvertised &&
              isReadableClaim(claim, props.snapshot.scopes);
            const path = `organization/${claim.scopeKind}/${claim.id}`;
            return html`<div class="settings-row memory-promotions__claim-row">
              <span class="settings-row__text">
                ${readable
                  ? html`<button
                      type="button"
                      class="memory-promotions__claim-title"
                      @click=${() => props.onOpen(path)}
                    >
                      ${claim.title}
                    </button>`
                  : html`<span class="settings-row__title">${claim.title}</span>`}
                <span class="settings-row__desc">
                  ${claim.scopeName} · ${promotionStatusLabel(claim.status)} ·
                  ${t("memoryPage.promotions.revision", { revision: String(claim.revision) })} ·
                  ${t("memoryPage.promotions.claimUpdated", {
                    timestamp: `${formatMs(claim.updatedAt)} · ${formatRelativeTimestamp(claim.updatedAt)}`,
                  })}
                </span>
                ${body
                  ? html`<span class="memory-promotions__claim-snippet"
                      >${body.length > 320 ? `${body.slice(0, 319)}…` : body}</span
                    >`
                  : nothing}
              </span>
              <span class="settings-row__control">
                ${readable
                  ? html`<button
                      class="btn btn--sm"
                      type="button"
                      @click=${() => props.onOpen(path)}
                    >
                      ${t("memoryPage.promotions.readClaim")}
                    </button>`
                  : nothing}
                ${claim.status === "active" && claim.canRetire
                  ? html`<button
                      class="btn btn--sm"
                      ?disabled=${props.loading}
                      @click=${() => props.onRetire(claim.id, false)}
                    >
                      ${t("memoryPage.promotions.retire")}
                    </button>`
                  : claim.status === "retired" && claim.canPurge
                    ? html`<button
                        class="btn btn--sm danger"
                        ?disabled=${props.loading}
                        @click=${() => props.onRetire(claim.id, true)}
                      >
                        ${t("memoryPage.promotions.purge")}
                      </button>`
                    : nothing}
              </span>
            </div>`;
          })
        : html`<p class="memory-promotions__empty">
            ${claims.length > 0
              ? t("memoryPage.promotions.claimsNoMatch")
              : t("memoryPage.promotions.noClaims")}
          </p>`}
    </div>
    ${props.snapshot.next
      ? html`<button
          class="btn btn--sm memory-promotions__claims-load-more"
          ?disabled=${props.loading}
          @click=${props.onLoadMore}
        >
          ${t("memoryPage.promotions.loadMore")}
        </button>`
      : nothing}
  </section>`;
}
