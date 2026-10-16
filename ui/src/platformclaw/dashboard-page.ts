import { html, nothing, svg } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  DashboardQuery,
  DashboardReport,
} from "../../../packages/platformclaw-control-plane/src/dashboard-contracts.js";
import { icons } from "../components/icons.ts";
import { i18n } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "../styles/platformclaw-dashboard.css";
import { dashboardPreset, dashboardUrl, requestDashboard } from "./dashboard-api.ts";
import { loadPlatformClawLocale, platformClawT } from "./i18n.ts";

const t = (key: string, params?: Record<string, string>) =>
  platformClawT(`platformClaw.dashboard.${key}`, params);

class PlatformClawDashboardPage extends OpenClawLightDomElement {
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => {};
  @state() private query: DashboardQuery = {
    ...dashboardPreset(30, "Asia/Seoul"),
    timeZone: "Asia/Seoul",
    accountId: "",
    organizationId: "",
    channel: "",
    kind: "",
  };
  @state() private report: DashboardReport | null = null;
  @state() private loading = true;
  @state() private exporting = false;
  @state() private error = "";
  @state() private chartMetric: "requests" | "activeAccounts" = "requests";
  @state() private chartWidth = 800;
  @state() private inspectedDay = -1;
  @state() private selectedCell = -1;
  @state() private sort: "requests" | "activeDays" | "lastActivity" = "requests";
  private controller?: AbortController;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private resizeObserver?: ResizeObserver;
  private fetching = false;
  private readonly onVisibilityChange = () => {
    const report = this.report;
    if (
      document.visibilityState === "visible" &&
      !this.fetching &&
      report &&
      (report.cacheStatus !== "fresh" || report.previousCacheStatus !== "fresh") &&
      JSON.stringify(this.query) === JSON.stringify(report.query)
    ) {
      void this.refresh(true);
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.resizeObserver?.observe(this);
    void loadPlatformClawLocale().then(() => {
      if (this.isConnected) {
        void this.refresh();
      }
    });
  }

  override firstUpdated(): void {
    this.resizeObserver = new ResizeObserver((entries) => {
      const width =
        this.querySelector(".pc-dashboard-chart")?.getBoundingClientRect().width ??
        entries[0]?.contentRect.width;
      if (width) {
        this.chartWidth = Math.max(240, width);
      }
    });
    this.resizeObserver.observe(this);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.controller?.abort();
    clearTimeout(this.refreshTimer);
    this.resizeObserver?.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private number(value: number, decimals = 0): string {
    return new Intl.NumberFormat(i18n.getLocale(), { maximumFractionDigits: decimals }).format(
      value,
    );
  }

  private date(value: number): string {
    return new Intl.DateTimeFormat(i18n.getLocale(), {
      timeZone: this.report?.query.timeZone ?? this.query.timeZone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(value);
  }

  private setFilter(key: keyof DashboardQuery, value: string): void {
    this.query = { ...this.query, [key]: value };
  }

  private applyPreset(days: number): void {
    try {
      this.query = { ...this.query, ...dashboardPreset(days, this.query.timeZone) };
      void this.refresh();
    } catch {
      this.error = t("invalidTimeZone");
    }
  }

  private async refresh(background = false): Promise<void> {
    clearTimeout(this.refreshTimer);
    try {
      new Intl.DateTimeFormat("en", { timeZone: this.query.timeZone }).format();
    } catch {
      this.error = t("invalidTimeZone");
      this.loading = false;
      return;
    }
    const start = Date.parse(`${this.query.startDate}T00:00:00Z`);
    const end = Date.parse(`${this.query.endDate}T00:00:00Z`);
    const days = (end - start) / 86_400_000 + 1;
    if (!Number.isFinite(days) || days < 1 || days > 366) {
      this.error = t("invalidRange");
      this.loading = false;
      return;
    }
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.fetching = true;
    if (!background) {
      this.loading = true;
    }
    this.error = "";
    const query = { ...this.query };
    try {
      const report = await requestDashboard(
        this.fetchImpl,
        query,
        controller.signal,
        this.onUnauthenticated,
      );
      if (!controller.signal.aborted && this.isConnected) {
        this.report = report;
        this.inspectedDay = -1;
        this.selectedCell = -1;
        // Gateway explicitly reports pending rollups. Refresh that known state,
        // but leave network failures to the visible user-operated retry action.
        if (report.cacheStatus !== "fresh" || report.previousCacheStatus !== "fresh") {
          this.refreshTimer = setTimeout(() => {
            if (
              document.visibilityState === "visible" &&
              JSON.stringify(this.query) === JSON.stringify(report.query)
            ) {
              void this.refresh(true);
            }
          }, 5_000);
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        this.error = t("error");
      }
    } finally {
      if (this.controller === controller) {
        this.fetching = false;
        this.loading = false;
      }
    }
  }

  private async exportExcel(): Promise<void> {
    if (!this.report || this.exporting) {
      return;
    }
    this.exporting = true;
    this.error = "";
    try {
      const query = this.report.query;
      const response = await this.fetchImpl(dashboardUrl(query, true), {
        credentials: "same-origin",
      });
      if (response.status === 401) {
        this.onUnauthenticated();
      }
      if (!response.ok) {
        throw new Error("Export failed");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `platformclaw-dashboard-${query.startDate}-${query.endDate}.xlsx`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      this.error = t("exportError");
    } finally {
      this.exporting = false;
    }
  }

  private selectAccount(accountId: string): void {
    this.query = { ...this.report!.query, accountId };
    void this.refresh();
  }

  private renderFilters() {
    const options = this.report?.options;
    const select = (
      key: "accountId" | "organizationId" | "channel" | "kind",
      label: string,
      items: Array<{ value: string; label: string }>,
    ) => html` <label class="pc-dashboard-field"
      ><span>${t(label)}</span>
      <select
        .value=${this.query[key]}
        aria-label=${t(label)}
        @change=${(event: Event) => this.setFilter(key, (event.target as HTMLSelectElement).value)}
      >
        <option value="">${t("all")}</option>
        ${items.map((item) => html`<option value=${item.value}>${item.label}</option>`)}
      </select>
    </label>`;
    return html`<form
      class="pc-dashboard-filters"
      @submit=${(event: Event) => {
        event.preventDefault();
        void this.refresh();
      }}
    >
      <div class="pc-dashboard-period">
        <span>${t("period")}</span>
        <div class="pc-dashboard-presets">
          ${[1, 7, 30, 90].map(
            (days) => html` <button
              type="button"
              class="btn btn--sm"
              @click=${() => {
                this.applyPreset(days);
              }}
            >
              ${days === 1 ? t("today") : t("days", { count: String(days) })}
            </button>`,
          )}
        </div>
      </div>
      <div class="pc-dashboard-filter-grid">
        <label class="pc-dashboard-field"
          ><span>${t("start")}</span
          ><input
            type="date"
            required
            .value=${this.query.startDate}
            @change=${(event: Event) =>
              this.setFilter("startDate", (event.target as HTMLInputElement).value)}
        /></label>
        <label class="pc-dashboard-field"
          ><span>${t("end")}</span
          ><input
            type="date"
            required
            .value=${this.query.endDate}
            @change=${(event: Event) =>
              this.setFilter("endDate", (event.target as HTMLInputElement).value)}
        /></label>
        ${select(
          "organizationId",
          "organization",
          options?.organizations.map((entry) => ({ value: entry.id, label: entry.name })) ?? [],
        )}
        ${select(
          "accountId",
          "account",
          options?.accounts.map((entry) => ({
            value: entry.accountId,
            label: `${entry.displayName ?? entry.accountId} · ${entry.accountId}`,
          })) ?? [],
        )}
        ${select(
          "channel",
          "channel",
          options?.channels.map((value) => ({ value, label: value })) ?? [],
        )}
        ${select("kind", "kind", options?.kinds.map((value) => ({ value, label: t(value) })) ?? [])}
        <label class="pc-dashboard-field"
          ><span>${t("timeZone")}</span
          ><input
            type="text"
            required
            .value=${this.query.timeZone}
            @change=${(event: Event) =>
              this.setFilter("timeZone", (event.target as HTMLInputElement).value)}
        /></label>
        <button class="btn primary" type="submit" ?disabled=${this.loading}>${t("apply")}</button>
      </div>
    </form>`;
  }

  private renderTrend(report: DashboardReport) {
    const width = this.chartWidth;
    const height = 220;
    const left = 56;
    const right = width - 16;
    const top = 24;
    const bottom = 184;
    const values = report.daily.map((day) => day[this.chartMetric]);
    const maximum = Math.max(1, ...values);
    const x = (index: number) => left + (index / Math.max(1, values.length - 1)) * (right - left);
    const y = (value: number) => bottom - (value / maximum) * (bottom - top);
    const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
    const inspected = this.inspectedDay < 0 ? null : report.daily[this.inspectedDay];
    const tickIndices = [...new Set([0, Math.floor((values.length - 1) / 2), values.length - 1])];
    return html`<section class="pc-dashboard-panel pc-dashboard-trend">
      <div class="pc-dashboard-panel-heading">
        <h2>${t("trend")}</h2>
        <div class="pc-dashboard-switch">
          ${(["requests", "activeAccounts"] as const).map(
            (metric) => html` <button
              type="button"
              class="btn btn--sm ${metric === this.chartMetric ? "primary" : ""}"
              aria-pressed=${metric === this.chartMetric}
              @click=${() => {
                this.chartMetric = metric;
              }}
            >
              ${t(metric === "requests" ? "requests" : "active")}
            </button>`,
          )}
        </div>
      </div>
      <svg
        class="pc-dashboard-chart"
        viewBox=${`0 0 ${width} ${height}`}
        role="img"
        aria-label=${t("trend")}
        @pointermove=${(event: PointerEvent) => {
          const bounds = (event.currentTarget as SVGElement).getBoundingClientRect();
          this.inspectedDay = Math.max(
            0,
            Math.min(
              values.length - 1,
              Math.round(
                ((((event.clientX - bounds.left) * width) / bounds.width - left) / (right - left)) *
                  (values.length - 1),
              ),
            ),
          );
        }}
        @pointerleave=${() => {
          this.inspectedDay = -1;
        }}
      >
        <title>${t("trend")} · ${report.query.startDate} – ${report.query.endDate}</title>
        ${[0, 0.5, 1].map(
          (ratio) =>
            svg`<line x1=${left} x2=${right} y1=${y(maximum * ratio)} y2=${y(maximum * ratio)} class="pc-dashboard-gridline"/><text x=${left - 10} y=${y(maximum * ratio) + 4} text-anchor="end">${this.number(maximum * ratio, 1)}</text>`,
        )}
        <polygon
          points=${`${left},${bottom} ${points} ${right},${bottom}`}
          class="pc-dashboard-area"
        />
        <polyline points=${points} class="pc-dashboard-line" />
        ${values.length === 1
          ? svg`<circle cx=${x(0)} cy=${y(values[0]!)} r="4" class="pc-dashboard-dot"/>`
          : nothing}
        ${tickIndices.map(
          (index) =>
            svg`<text x=${x(index)} y="210" text-anchor=${index === 0 ? "start" : index === values.length - 1 ? "end" : "middle"}>${report.daily[index]!.date.slice(5)}</text>`,
        )}
        ${inspected
          ? svg`<line x1=${x(this.inspectedDay)} x2=${x(this.inspectedDay)} y1=${top} y2=${bottom} class="pc-dashboard-guide"/><circle cx=${x(this.inspectedDay)} cy=${y(inspected[this.chartMetric])} r="5" class="pc-dashboard-dot"/>`
          : nothing}
      </svg>
      <div class="pc-dashboard-chart-detail">
        ${inspected
          ? `${inspected.date} · ${t("requests")} ${this.number(inspected.requests)} · ${t("active")} ${this.number(inspected.activeAccounts)}`
          : `${report.query.startDate} — ${report.query.endDate} · ${report.query.timeZone}`}
      </div>
    </section>`;
  }

  private renderHeatmap(report: DashboardReport) {
    const weekdays = t("weekdays").split(",");
    const max = Math.max(1, ...report.heatmap.map((cell) => cell.requests));
    const selected = report.heatmap[this.selectedCell];
    const label = (cell: DashboardReport["heatmap"][number]) =>
      t("heatmapDetail", {
        day: weekdays[cell.weekday]!,
        hour: String(cell.hour).padStart(2, "0"),
        count: this.number(cell.requests),
      });
    return html`<section class="pc-dashboard-panel">
      <h2>${t("heatmap")}</h2>
      <p class="pc-dashboard-muted">${t("heatmapHint", { zone: report.query.timeZone })}</p>
      <div class="pc-dashboard-heatmap-scroll">
        <div class="pc-dashboard-heatmap" role="group" aria-label=${t("heatmap")}>
          <span></span>${Array.from(
            { length: 24 },
            (_, hour) =>
              html`<span class="pc-dashboard-hour"
                >${hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}</span
              >`,
          )}
          ${weekdays.map(
            (day, weekday) =>
              html`<span class="pc-dashboard-weekday">${day}</span>${report.heatmap
                  .filter((cell) => cell.weekday === weekday)
                  .map(
                    (cell) => html` <button
                      type="button"
                      class="pc-dashboard-heatcell"
                      aria-label=${label(cell)}
                      title=${label(cell)}
                      aria-pressed=${this.selectedCell === weekday * 24 + cell.hour}
                      style=${`--pc-dashboard-intensity: ${cell.requests === 0 ? 0 : 18 + (cell.requests / max) * 78}%`}
                      @click=${() => {
                        this.selectedCell = weekday * 24 + cell.hour;
                      }}
                    ></button>`,
                  )}`,
          )}
        </div>
      </div>
      <div class="pc-dashboard-heatmap-footer">
        <span aria-live="polite"
          >${selected
            ? label(selected)
            : `${t("requests")} · ${this.number(report.totals.requests)}`}</span
        ><span class="pc-dashboard-legend">${t("less")}<i></i>${t("more")}</span>
      </div>
    </section>`;
  }

  private change(current: number, previous: number): string {
    if (this.report?.cacheStatus !== "fresh" || this.report?.previousCacheStatus !== "fresh") {
      return "—";
    }
    if (!previous) {
      return current ? "+" + this.number(current) : "—";
    }
    const pct = ((current - previous) / previous) * 100;
    return `${pct > 0 ? "+" : ""}${this.number(pct, Math.abs(pct) < 1 ? 2 : 1)}%`;
  }

  private renderAccounts(report: DashboardReport) {
    const accounts = report.accounts.toSorted(
      (a, b) => (b[this.sort] ?? 0) - (a[this.sort] ?? 0) || a.accountId.localeCompare(b.accountId),
    );
    return html`<section class="pc-dashboard-panel">
      <div class="pc-dashboard-panel-heading">
        <div>
          <h2>
            ${t("accounts")} <span class="pc-dashboard-count">${this.number(accounts.length)}</span>
          </h2>
          <p class="pc-dashboard-muted">${t("accountHint")}</p>
        </div>
        ${report.query.accountId
          ? html`<button class="btn btn--sm" @click=${() => this.selectAccount("")}>
              ${icons.arrowLeft}${t("back")}
            </button>`
          : nothing}
      </div>
      <div class="pc-dashboard-table-scroll">
        <table class="pc-dashboard-table">
          <thead>
            <tr>
              <th>${t("account")}</th>
              <th>${t("organization")}</th>
              ${(["requests", "activeDays"] as const).map(
                (key) =>
                  html`<th
                    class="pc-dashboard-numeric"
                    aria-sort=${this.sort === key ? "descending" : "none"}
                  >
                    <button
                      type="button"
                      @click=${() => {
                        this.sort = key;
                      }}
                    >
                      ${t(key)} ${this.sort === key ? "↓" : ""}
                    </button>
                  </th>`,
              )}
              <th class="pc-dashboard-numeric">${t("change")}</th>
              <th class="pc-dashboard-numeric">${t("tokens")}</th>
              <th aria-sort=${this.sort === "lastActivity" ? "descending" : "none"}>
                <button
                  type="button"
                  @click=${() => {
                    this.sort = "lastActivity";
                  }}
                >
                  ${t("lastActivity")}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            ${accounts.map(
              (account) => html`<tr>
                <td>
                  <button
                    type="button"
                    class="pc-dashboard-account"
                    @click=${() => this.selectAccount(account.accountId)}
                  >
                    <span class="pc-dashboard-avatar" aria-hidden="true"
                      >${(account.displayName ?? account.accountId).slice(0, 1)}</span
                    ><span
                      ><strong>${account.displayName ?? account.accountId}</strong
                      ><small
                        >${account.accountId}${account.status === "disabled"
                          ? ` · ${t("disabled")}`
                          : ""}</small
                      ></span
                    >
                  </button>
                </td>
                <td>${account.organizationName ?? t("unassigned")}</td>
                <td class="pc-dashboard-numeric">${this.number(account.requests)}</td>
                <td class="pc-dashboard-numeric">${this.number(account.activeDays)}</td>
                <td class="pc-dashboard-numeric">
                  ${this.change(account.requests, account.previousRequests)}
                </td>
                <td class="pc-dashboard-numeric">${this.number(account.tokens)}</td>
                <td class="pc-dashboard-last">
                  ${account.lastActivity ? this.date(account.lastActivity) : "—"}
                </td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
      ${report.totals.requests === 0
        ? html`<p class="pc-dashboard-empty">${t("empty")}</p>`
        : nothing}
    </section>`;
  }

  override render() {
    const report = this.report;
    const totals = report?.totals;
    const applied = report
      ? [
          report.query.accountId,
          report.options.organizations.find(
            (organization) => organization.id === report.query.organizationId,
          )?.name,
          report.query.channel,
          report.query.kind ? t(report.query.kind) : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
    return html`<main class="pc-dashboard" aria-busy=${this.loading}>
      <header class="pc-dashboard-heading">
        <div>
          <p class="pc-dashboard-eyebrow">${t("eyebrow")}</p>
          <h1>${t("title")}</h1>
          <p class="pc-dashboard-muted">${t("subtitle")}</p>
        </div>
        <div class="pc-dashboard-actions">
          <button
            class="btn"
            type="button"
            ?disabled=${this.loading}
            @click=${() => this.refresh()}
          >
            ${icons.refresh}${t("refresh")}</button
          ><button
            class="btn primary"
            type="button"
            ?disabled=${!report || this.loading || this.exporting}
            @click=${() => this.exportExcel()}
          >
            ${icons.download}${this.exporting ? t("exporting") : t("export")}
          </button>
        </div>
      </header>
      <div class="pc-dashboard-access">${icons.users}${t("access")}</div>
      ${this.renderFilters()}
      ${this.error ? html`<p class="pc-dashboard-alert" role="alert">${this.error}</p>` : nothing}
      ${this.loading
        ? html`<p role="status" class="pc-dashboard-muted">${t("loading")}</p>`
        : nothing}
      ${report && totals
        ? html`
            <div class="pc-dashboard-applied">
              ${report.query.startDate} — ${report.query.endDate} ·
              ${report.query.timeZone}${applied ? ` · ${applied}` : ""}
              <span>${t("updated", { time: this.date(report.updatedAt) })}</span>
            </div>
            ${report.cacheStatus !== "fresh"
              ? html`<p class="pc-dashboard-alert" role="status">${t("partial")}</p>`
              : nothing}
            ${report.previousCacheStatus !== "fresh"
              ? html`<p class="pc-dashboard-alert" role="status">${t("previousPartial")}</p>`
              : nothing}
            <div class="pc-dashboard-stats">
              <article>
                <span>${t("active")}</span
                ><strong
                  >${this.number(totals.activeAccounts)}<small>
                    / ${this.number(totals.registeredAccounts)}</small
                  ></strong
                >
                <p>${t("registered", { count: this.number(totals.registeredAccounts) })}</p>
              </article>
              <article>
                <span>${t("adoption")}</span
                ><strong
                  >${this.number(
                    totals.registeredAccounts
                      ? (totals.activeAccounts / totals.registeredAccounts) * 100
                      : 0,
                    1,
                  )}<small>%</small></strong
                >
                <div class="pc-dashboard-meter">
                  <i
                    style=${`width: ${totals.registeredAccounts ? (totals.activeAccounts / totals.registeredAccounts) * 100 : 0}%`}
                  ></i>
                </div>
              </article>
              <article>
                <span>${t("requests")}</span><strong>${this.number(totals.requests)}</strong>
                <p>
                  ${t("previous", { count: this.number(totals.previousRequests) })} ·
                  ${this.change(totals.requests, totals.previousRequests)}
                </p>
              </article>
              <article>
                <span>${t("perAccount")}</span
                ><strong
                  >${this.number(
                    totals.activeAccounts ? totals.requests / totals.activeAccounts : 0,
                    1,
                  )}</strong
                >
                <p>${t("requests")}</p>
              </article>
            </div>
            ${this.renderTrend(report)}${this.renderHeatmap(report)}${this.renderAccounts(report)}
            <div class="pc-dashboard-resources">
              <span>${t("toolCalls")} <strong>${this.number(totals.toolCalls)}</strong></span
              ><span>${t("tokens")} <strong>${this.number(totals.tokens)}</strong></span
              ><span>${t("cost")} <strong>$${this.number(totals.estimatedCost, 4)}</strong></span>
            </div>
            ${totals.missingCostEntries
              ? html`<p class="pc-dashboard-alert">
                  ${t("unpriced", { count: this.number(totals.missingCostEntries) })}
                </p>`
              : nothing}
            <footer class="pc-dashboard-definitions">
              <p>${t("definition")}</p>
              <p>${t("coverage")}</p>
            </footer>
          `
        : nothing}
    </main>`;
  }
}

if (!customElements.get("platformclaw-dashboard-page")) {
  customElements.define("platformclaw-dashboard-page", PlatformClawDashboardPage);
}

declare global {
  interface HTMLElementTagNameMap {
    "platformclaw-dashboard-page": PlatformClawDashboardPage;
  }
}
