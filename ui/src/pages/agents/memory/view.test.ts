/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import type { TranslationMap } from "../../../i18n/lib/types.ts";
import { en } from "../../../i18n/locales/en.ts";
import { loadPlatformClawLocale } from "../../../platformclaw/i18n.ts";
import { buildDreamingViewProps, type DreamingProps } from "./view.test-helpers.ts";
import {
  createDreamingViewState,
  resetWikiLocalState,
  renderDreaming,
  renderWikiKnowledge,
  type DreamingViewState,
} from "./view.ts";

let viewState = createDreamingViewState();
let restoreTranslations = () => {};

const asTranslationMap = (value: string | TranslationMap | undefined): TranslationMap =>
  value && typeof value === "object" ? value : {};

beforeAll(async () => {
  await loadPlatformClawLocale();
  const dreaming = asTranslationMap(en.dreaming);
  const wiki = asTranslationMap(dreaming.wiki);
  i18n.registerTranslation("en", {
    ...en,
    dreaming: {
      ...dreaming,
      wiki: {
        ...wiki,
        pageTypes: {
          entity: "entity",
          concept: "concept",
          source: "source",
          synthesis: "synthesis",
          report: "report",
        },
        pageGroups: {
          sources: "Sources",
          syntheses: "Syntheses",
          reports: "Reports",
          entities: "Entities",
          concepts: "Concepts",
        },
        counts: {
          pageOne: "{count} page",
          pages: "{count} pages",
          claimRowOne: "{count} claim row",
          claimRows: "{count} claim rows",
          openQuestionOne: "{count} open question",
          openQuestions: "{count} open questions",
          contradictionOne: "{count} contradiction",
          contradictions: "{count} contradictions",
          chats: "{count} chats",
          sensitive: "{count} sensitive",
          signals: "{count} signals",
          messages: "{count} messages",
          userMessages: "{count} user",
          assistantMessages: "{count} assistant",
        },
        pageGroupSummary: "{label} · {count}",
        noPagesYet: "No pages yet",
        sectionPageSummary: "{label}: {count}",
        questionCountOnPages: "{questionCount} on {pageCount}",
        risk: {
          needsReview: "needs review",
          low: "low risk",
          medium: "medium risk",
          high: "high risk",
          unknown: "unknown risk",
        },
        pageNotFound: "No wiki page found for {lookup}.",
        previewTruncated: "Showing the first chunk of this page.",
        previewTruncatedWithTotal: "Showing the first chunk of this page ({count} total lines).",
        importedClusterSummary: "Imported chats clustered around {label}.",
        withheldDigestOne: "{count} digest was withheld pending review.",
        withheldDigests: "{count} digests were withheld pending review.",
        details: "Details",
        hideDetails: "Hide details",
        vault: "Vault",
        fullVaultBreakdown: "Full vault breakdown: {breakdown}.",
        selectedSection: "Selected section: {summary}.",
        latestUpdate: "Latest update {date}.",
      },
    },
  });
  restoreTranslations = () => i18n.registerTranslation("en", en);
});

afterAll(() => {
  restoreTranslations();
});

const setDreamSubTab = (tab: DreamingViewState["activeSubTab"]) => (viewState.activeSubTab = tab);

function setDreamDiarySubTab(tab: DreamingViewState["activeDiarySubTab"]) {
  viewState.activeDiarySubTab = tab;
}

function setDreamAdvancedWaitingSort(sort: DreamingViewState["advancedWaitingSort"]) {
  viewState.advancedWaitingSort = sort;
}

const buildProps = (overrides?: Partial<DreamingProps>) =>
  buildDreamingViewProps(viewState, overrides);

function renderInto(props: DreamingProps): HTMLDivElement {
  const container = document.createElement("div");
  const wikiSurface =
    props.viewState.activeSubTab === "diary" && props.viewState.activeDiarySubTab !== "dreams";
  render(wikiSurface ? renderWikiKnowledge(props) : renderDreaming(props), container);
  return container;
}

function expectElement(container: Element, selector: string): Element {
  const element = container.querySelector(selector);
  expect(element).toBeInstanceOf(Element);
  if (!(element instanceof Element)) {
    throw new Error(`Expected element matching ${selector}`);
  }
  return element;
}

function compactText(node: Element | null): string | undefined {
  return node?.textContent?.trim().replace(/\s+/g, " ");
}

function textItems(container: Element, selector: string): Array<string | undefined> {
  return [...container.querySelectorAll(selector)].map((node) => node.textContent?.trim());
}

describe("dreaming view", () => {
  beforeEach(() => {
    viewState = createDreamingViewState();
  });

  it("renders configured dreaming status with shared settings rows and navigation callbacks", () => {
    const onViewStateChange = vi.fn();
    const container = renderInto(buildProps({ onViewStateChange }));

    expectElement(container, ".dreams__lobster svg");

    // The sleeper is the seeded pet cameo: eyes closed, pupils hidden.
    const closedEyes = container.querySelector<SVGGElement>(".dreams__lobster .lob-eye-closed");
    expect(closedEyes?.getAttribute("style")).toContain("opacity:1");
    const openEyes = container.querySelector<SVGGElement>(".dreams__lobster .lob-eye-open");
    expect(openEyes?.getAttribute("style")).toContain("display:none");
    expect(
      container.querySelector<HTMLElement>(".dreams__lobster")?.getAttribute("style"),
    ).toContain("--lob-shell:");

    expect(container.querySelector(".dreams__star")).toBeNull();
    expect(container.querySelector(".dreams__moon")).toBeNull();
    expect(container.querySelector(".dreams__bubble")).toBeNull();
    expect(container.querySelector(".dreams__summary-grid")).toBeNull();
    expect(container.querySelector(".dreams__phase")).toBeNull();
    expect(container.querySelector(".dreams__status-label")).toBeNull();
    expect(container.textContent).toContain("Automatic consolidation on");
    expect(container.textContent).not.toMatch(/running|active/i);
    expect(container.textContent).toContain("47");
    expect(container.textContent).toContain("12");
    expect(container.textContent).toContain("24");
    expect(container.textContent).toContain("Light");
    expect(container.textContent).toContain("Deep");
    expect(container.textContent).toContain("REM");

    const summaryNav = [
      ...container.querySelectorAll<HTMLButtonElement>("button.settings-row--nav"),
    ];
    expect(summaryNav).toHaveLength(2);
    summaryNav[0]?.click();
    expect(viewState.activeSubTab).toBe("advanced");
    summaryNav[1]?.click();
    expect(viewState.activeSubTab).toBe("diary");
    expect(onViewStateChange).toHaveBeenCalledTimes(2);
  });

  it("distinguishes disabled configuration from unavailable runtime status", () => {
    const idleContainer = renderInto(buildProps({ active: false }));
    expect(idleContainer.textContent).toContain("Automatic consolidation off");
    expectElement(idleContainer, ".dreams--idle");
    expect(idleContainer.textContent).toContain("Off");

    const unavailableContainer = renderInto(
      buildProps({
        statusAvailable: false,
        statusLoading: true,
        shortTermCount: 0,
        promotedCount: 0,
        promotedTotal: 0,
        phases: undefined,
      }),
    );
    expect(unavailableContainer.textContent).toContain("Refreshing status");
    expect(unavailableContainer.textContent).not.toContain("Status unavailable");
    expect(unavailableContainer.textContent).not.toContain("Promoted today 0");
    expect(unavailableContainer.textContent).not.toContain("Total promotions 0");

    const errorContainer = renderInto(
      buildProps({ statusAvailable: false, statusError: "patch failed" }),
    );
    expect(errorContainer.textContent).toContain("patch failed");
    expect(errorContainer.textContent).toContain("Status unavailable");
  });

  it("renders imported memory topics inside the diary tab", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("insights");
    const onViewStateChange = vi.fn();
    const container = renderInto(buildProps({ onViewStateChange }));
    const subtabs = [...container.querySelectorAll(".memory-wiki-hub-tabs .hub-tab")];
    expect(subtabs.map((tab) => tab.textContent?.trim()).join("|")).toBe("Documents|Imported");
    container
      .querySelector("#memory-wiki-tab-wiki")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    expect(viewState.activeDiarySubTab).toBe("wiki");
    expect(onViewStateChange).toHaveBeenCalledOnce();
    expect(compactText(container.querySelector(".dreams-diary__date"))).toBe(
      "Travel · 1 chats · 1 signals",
    );
    expect(compactText(container.querySelector(".dreams-diary__para"))).toBe(
      "Imported chats clustered around travel.",
    );
    const insight = container.querySelector(".dreams-diary__insight-card");
    expect(insight?.querySelector(".dreams-diary__insight-title")?.textContent?.trim()).toBe(
      "BA flight receipts process",
    );
    expect(compactText(insight?.querySelector(".dreams-diary__insight-badge") ?? null)).toBe(
      "low risk",
    );
    expect(insight?.querySelector(".dreams-diary__insight-line")?.textContent).toBe(
      "Use the BA request-a-receipt flow first.",
    );
    expect(compactText(insight?.querySelector(".dreams-diary__insight-actions .btn") ?? null)).toBe(
      "Details",
    );
    expect(compactText(container.querySelector(".dreams-diary__explainer"))).toBe(
      "These are imported insights clustered from external history; use them to review what imports surfaced before any of it graduates into durable memory.",
    );
    setDreamDiarySubTab("dreams");
    setDreamSubTab("scene");
  });

  it("renders sensitive imported insight summaries and review badges", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("insights");
    viewState.diaryPage = 1;

    const container = renderInto(buildProps());

    expect(compactText(container.querySelector(".dreams-diary__date"))).toBe(
      "Health · 1 chats · 1 sensitive",
    );
    expect(compactText(container.querySelector(".dreams-diary__para"))).toBe(
      "Imported chats clustered around health. 1 digest was withheld pending review.",
    );
    expect(compactText(container.querySelector(".dreams-diary__insight-badge"))).toBe(
      "needs review",
    );
    setDreamDiarySubTab("dreams");
    setDreamSubTab("scene");
  });

  it("opens the full imported source page from diary cards", async () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("insights");
    const onOpenWikiPage = vi.fn().mockResolvedValue({
      title: "BA flight receipts process",
      path: "sources/chatgpt-2026-04-10-alpha.md",
      content: "# ChatGPT Export: BA flight receipts process",
    });
    const container = renderInto(buildProps({ onOpenWikiPage }));
    const openSourceButton = container.querySelector<HTMLButtonElement>(
      ".dreams-diary__insight-title",
    );
    expect(openSourceButton).toBeInstanceOf(HTMLButtonElement);
    if (!(openSourceButton instanceof HTMLButtonElement)) {
      throw new Error("Expected imported source button");
    }
    openSourceButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(onOpenWikiPage).toHaveBeenCalledWith("sources/chatgpt-2026-04-10-alpha.md");
    setDreamDiarySubTab("dreams");
    setDreamSubTab("scene");
  });

  it("shows a truncation hint when the wiki preview only contains the first chunk", async () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("insights");
    const container = document.createElement("div");
    const onOpenWikiPage = vi.fn().mockResolvedValue({
      title: "BA flight receipts process",
      path: "sources/chatgpt-2026-04-10-alpha.md",
      content: "# ChatGPT Export: BA flight receipts process",
      totalLines: 6001,
      truncated: true,
    });
    const rerender = () => render(renderWikiKnowledge(props), container);
    const props: DreamingProps = buildProps({
      onOpenWikiPage,
      onViewStateChange: rerender,
    });
    rerender();

    const openSourceButton = container.querySelector<HTMLButtonElement>(
      ".dreams-diary__insight-title",
    );
    expect(openSourceButton).toBeInstanceOf(HTMLButtonElement);
    if (!(openSourceButton instanceof HTMLButtonElement)) {
      throw new Error("Expected imported source button");
    }
    openSourceButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(compactText(container.querySelector(".dreams-diary__preview-hint"))).toBe(
      "Showing the first chunk of this page (6001 total lines).",
    );
    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();
    expect(container.querySelector(".dreams-diary__preview-backdrop")).toBeNull();

    const closePreviewButton = container.querySelector<HTMLButtonElement>(
      ".dreams-diary__preview-header .btn",
    );
    expect(closePreviewButton).toBeInstanceOf(HTMLButtonElement);
    closePreviewButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    setDreamDiarySubTab("dreams");
    setDreamSubTab("scene");
  });

  it("renders the wiki overview inside the diary tab", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("wiki");
    const container = renderInto(buildProps());
    expect(compactText(container.querySelector(".memory-wiki-filterbar__count"))).toBe(
      "1 of 1 loaded documents · 2 pages in Wiki",
    );
    expect(
      container.querySelector<HTMLInputElement>(".memory-wiki-filterbar__search")?.placeholder,
    ).toBe("Filter title or path");
    const insight = container.querySelector(".dreams-diary__insight-card");
    expect(insight?.querySelector(".dreams-diary__insight-title")?.textContent?.trim()).toBe(
      "Travel system",
    );
    expect(compactText(insight?.querySelector(".dreams-diary__insight-badge") ?? null)).toBe(
      "synthesis",
    );
    expect(compactText(insight?.querySelector(".dreams-diary__insight-actions .btn") ?? null)).toBe(
      "Details",
    );
    expect(insight?.querySelector(".dreams-diary__insight-list")).toBeNull();
    expect(insight?.querySelectorAll(".dreams-diary__insight-actions button")).toHaveLength(1);
    expect(compactText(container.querySelector(".dreams-diary__explainer"))).toBe(
      "Find and read your compiled knowledge. Filters apply to the loaded documents.",
    );
    setDreamDiarySubTab("dreams");
    setDreamSubTab("scene");
  });

  it("filters loaded Wiki documents locally by query, kind, questions, and contradictions", () => {
    setDreamDiarySubTab("wiki");
    const base = buildProps();
    const firstCluster = expectDefined(base.wikiOverview?.clusters[0], "wiki cluster");
    const secondItem = {
      ...expectDefined(firstCluster.items[0], "wiki item"),
      pagePath: "concepts/ownership.md",
      title: "Release ownership",
      kind: "concept" as const,
      questionCount: 0,
      contradictionCount: 1,
      questions: [],
      contradictions: ["Older owner guidance conflicts."],
    };
    base.wikiOverview = {
      ...expectDefined(base.wikiOverview, "wiki overview"),
      totalItems: 2,
      totalPages: 4,
      clusters: [
        firstCluster,
        {
          ...firstCluster,
          key: "concept",
          label: "Concepts",
          items: [secondItem],
          itemCount: 1,
          questionCount: 0,
          contradictionCount: 1,
        },
      ],
    };
    const container = document.createElement("div");
    const rerender = () => render(renderWikiKnowledge(base), container);
    base.onViewStateChange = rerender;
    rerender();

    const search = expectElement(container, ".memory-wiki-filterbar__search") as HTMLInputElement;
    search.value = "ownership";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(container.querySelectorAll("[data-wiki-page]")).toHaveLength(1);
    expect(container.textContent).toContain("1 of 2 loaded documents · 4 pages in Wiki");

    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const kind = container.querySelector<HTMLSelectElement>(".memory-wiki-filterbar select");
    expect(kind).toBeInstanceOf(HTMLSelectElement);
    kind!.value = "concept";
    kind!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(container.querySelectorAll("[data-wiki-page]")).toHaveLength(1);

    kind!.value = "all";
    kind!.dispatchEvent(new Event("change", { bubbles: true }));
    const checks = [
      ...container.querySelectorAll<HTMLInputElement>(".memory-wiki-filterbar__check input"),
    ];
    checks[0]!.checked = true;
    checks[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(container.querySelectorAll("[data-wiki-page]")).toHaveLength(1);
    expect(container.textContent).toContain("Travel system");

    checks[0]!.checked = false;
    checks[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    checks[1]!.checked = true;
    checks[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(container.querySelectorAll("[data-wiki-page]")).toHaveLength(2);
  });

  it("resets local Wiki filters, expansion, page, and preview state", () => {
    viewState.diaryPage = 2;
    viewState.expandedInsightCards.add("sources/import.md");
    viewState.expandedWikiCards.add("concepts/ownership.md");
    viewState.wikiQuery = "owner";
    viewState.wikiKind = "concept";
    viewState.wikiQuestionsOnly = true;
    viewState.wikiContradictionsOnly = true;
    viewState.wikiPreviewOpen = true;
    viewState.wikiPreviewPath = "concepts/ownership.md";

    resetWikiLocalState(viewState);

    expect(viewState.diaryPage).toBe(0);
    expect(viewState.expandedInsightCards.size).toBe(0);
    expect(viewState.expandedWikiCards.size).toBe(0);
    expect(viewState.wikiQuery).toBe("");
    expect(viewState.wikiKind).toBe("all");
    expect(viewState.wikiQuestionsOnly).toBe(false);
    expect(viewState.wikiContradictionsOnly).toBe(false);
    expect(viewState.wikiPreviewOpen).toBe(false);
    expect(viewState.wikiPreviewPath).toBe("");
  });

  it("expands wiki document details only from the Details button", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("wiki");
    const container = document.createElement("div");
    const rerender = () => render(renderWikiKnowledge(props), container);
    const props: DreamingProps = buildProps({ onViewStateChange: rerender });
    rerender();

    const card = expectElement(container, "[data-wiki-page='syntheses/travel-system.md']");
    const details = card.querySelector<HTMLButtonElement>(".dreams-diary__insight-actions .btn");
    expect(details?.getAttribute("aria-expanded")).toBe("false");
    expect(details?.getAttribute("aria-controls")).toBe(
      "wiki-card-details-syntheses%2Ftravel-system.md",
    );
    details?.click();

    const expandedDetails = container.querySelector<HTMLButtonElement>(
      "[data-wiki-page='syntheses/travel-system.md'] .dreams-diary__insight-actions .btn",
    );
    expect(expandedDetails?.getAttribute("aria-expanded")).toBe("true");
    expect(textItems(container, ".dreams-diary__insight-list strong")).toContain("Page details");
    setDreamDiarySubTab("dreams");
    setDreamSubTab("scene");
  });

  it("opens wiki documents from the keyboard-accessible title control", async () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("wiki");
    const onOpenWikiPage = vi.fn().mockResolvedValue({
      title: "Weekly stock report",
      path: "reports/weekly-stock.md",
      content: "# Weekly stock report\n\nSummary content.",
      totalLines: 2,
      truncated: false,
    });
    const container = document.createElement("div");
    const rerender = () => render(renderWikiKnowledge(props), container);
    const props: DreamingProps = buildProps({
      onOpenWikiPage,
      onViewStateChange: rerender,
      wikiOverview: {
        totalItems: 1,
        totalPages: 1,
        pageCounts: {
          synthesis: 0,
          entity: 0,
          concept: 0,
          source: 1,
          report: 0,
        },
        totalClaims: 0,
        totalQuestions: 0,
        totalContradictions: 0,
        clusters: [
          {
            key: "report",
            label: "Reports",
            itemCount: 1,
            claimCount: 0,
            questionCount: 0,
            contradictionCount: 0,
            items: [
              {
                pagePath: "reports/weekly-stock.md",
                title: "Weekly stock report",
                kind: "report",
                claimCount: 0,
                questionCount: 0,
                contradictionCount: 0,
                claims: [],
                questions: [],
                contradictions: [],
                snippet: "Weekly stock summary.",
                updatedAt: "2026-04-12T10:00:00.000Z",
              },
            ],
          },
        ],
      },
    });
    rerender();

    const card = expectElement(container, "[data-wiki-page='reports/weekly-stock.md']");
    const title = card.querySelector<HTMLButtonElement>(".memory-wiki-card__title");
    expect(title).toBeInstanceOf(HTMLButtonElement);
    title?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onOpenWikiPage).toHaveBeenCalledWith("reports/weekly-stock.md");
    expect(textItems(container, ".dreams-diary__insight-list strong")).not.toContain(
      "Page details",
    );
    expect(compactText(container.querySelector(".dreams-diary__preview-title"))).toBe(
      "Weekly stock report",
    );
    expect(compactText(container.querySelector(".dreams-diary__preview-body"))).toBe(
      "Weekly stock report Summary content.",
    );

    const closePreviewButton = container.querySelector<HTMLButtonElement>(
      ".dreams-diary__preview-header .btn",
    );
    expect(closePreviewButton).toBeInstanceOf(HTMLButtonElement);
    closePreviewButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    setDreamDiarySubTab("dreams");
    setDreamSubTab("scene");
  });

  it("shows a memory-wiki enablement CTA when wiki subtabs are selected but the plugin is disabled", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("wiki");
    const onOpenConfig = vi.fn();
    const container = renderInto(
      buildProps({
        memoryWikiEnabled: false,
        onOpenConfig,
      }),
    );
    expect(container.querySelector(".dreams-diary__empty-text")?.textContent).toBe(
      "Memory Wiki is not enabled",
    );
    expect(
      [...container.querySelectorAll(".dreams-diary__empty-hint")].map((node) => compactText(node)),
    ).toEqual([
      "Imported Insights and Memory Wiki are provided by the bundled memory-wiki plugin.",
      "Enable plugins.entries.memory-wiki.enabled = true, then reload this tab.",
    ]);

    const configButton = container.querySelector<HTMLButtonElement>(
      ".dreams-diary__empty-actions .btn",
    );
    expect(configButton).toBeInstanceOf(HTMLButtonElement);
    configButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenConfig).toHaveBeenCalledTimes(1);
    setDreamDiarySubTab("dreams");
    setDreamSubTab("scene");
  });

  it("renders dream diary with parsed entry on diary tab", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("dreams");
    const container = renderInto(buildProps());
    const title = container.querySelector(".dreams-diary__title");
    expect(title?.textContent).toBe("Dream Diary");

    expectElement(container, ".dreams-diary__entry");
    const date = container.querySelector(".dreams-diary__date");
    expect(date?.textContent).toBe("April 5, 2026, 3:00 AM");
    const body = container.querySelector(".dreams-diary__para");
    expect(body?.textContent?.trim()).toBe(
      "The repository whispered of forgotten endpoints tonight.",
    );
    setDreamSubTab("scene");
  });

  it("renders dream diary markdown through the sanitized markdown pipeline", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("dreams");
    const container = renderInto(
      buildProps({
        dreamDiaryContent: [
          "# Dream Diary",
          "",
          "---",
          "",
          "*April 8, 2026*",
          "",
          "**Bold** and *italic*",
        ].join("\n"),
      }),
    );

    const body = container.querySelector(".dreams-diary__para");
    expect(body?.querySelector("strong")?.textContent).toBe("Bold");
    expect(body?.querySelector("em")?.textContent).toBe("italic");
    setDreamSubTab("scene");
  });

  it("flattens structured backfill diary entries into plain prose", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("dreams");
    const container = renderInto(
      buildProps({
        dreamDiaryContent: [
          "# Dream Diary",
          "",
          "<!-- openclaw:dreaming:diary:start -->",
          "",
          "---",
          "",
          "*January 1, 2026*",
          "",
          "<!-- openclaw:dreaming:backfill-entry day=2026-01-01 source=memory/2026-01-01.md -->",
          "",
          "What Happened",
          "1. Always use Happy Together for flights.",
          "",
          "Reflections",
          "1. Stable preferences were made explicit.",
          "",
          "Candidates",
          "- likely_durable: Happy Together rule",
          "",
          "Possible Lasting Updates",
          "- Use Happy Together for flights.",
          "",
          "<!-- openclaw:dreaming:diary:end -->",
        ].join("\n"),
      }),
    );
    const prose = [...container.querySelectorAll(".dreams-diary__para")].map((node) =>
      node.textContent?.trim(),
    );
    expect(prose).toEqual([
      "Always use Happy Together for flights.",
      "Stable preferences were made explicit.",
      "Happy Together rule",
      "Use Happy Together for flights.",
    ]);
    expect(container.querySelector(".dreams-diary__panel-title")).toBeNull();
    setDreamSubTab("scene");
  });

  it("renders diary day chips without the old density map", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("dreams");
    const container = renderInto(
      buildProps({
        dreamDiaryContent: [
          "# Dream Diary",
          "",
          "<!-- openclaw:dreaming:diary:start -->",
          "",
          "---",
          "",
          "*January 1, 2026*",
          "",
          "What Happened",
          "1. First durable fact.",
          "",
          "---",
          "",
          "*January 2, 2026*",
          "",
          "What Happened",
          "1. Second durable fact.",
          "",
          "Candidates",
          "- candidate",
          "",
          "<!-- openclaw:dreaming:diary:end -->",
        ].join("\n"),
      }),
    );
    const dayChips = [...container.querySelectorAll(".dreams-diary__day-chip")].map((node) => ({
      label: node.textContent?.replace(/\s+/g, "").trim(),
      active: node.classList.contains("dreams-diary__day-chip--active"),
    }));
    expect(dayChips).toEqual([
      { label: "1/2", active: true },
      { label: "1/1", active: false },
    ]);
    expect(container.querySelector(".dreams-diary__heatmap-cell")).toBeNull();
    expect(container.querySelector(".dreams-diary__timeline-month")).toBeNull();
    setDreamSubTab("scene");
  });

  it.each([
    { tab: "dreams", labels: ["1/2", "1/1"] },
    { tab: "insights", labels: ["Travel", "Health"] },
  ] as const)("keeps $tab navigation inside the sticky diary controls", ({ tab, labels }) => {
    setDreamSubTab("diary");
    setDreamDiarySubTab(tab);
    const props = buildProps({
      dreamDiaryContent: [
        "# Dream Diary",
        "---",
        "*January 1, 2026*",
        "An earlier dream.",
        "---",
        "*January 2, 2026*",
        ...Array.from({ length: 12 }, (_, index) => `Long diary paragraph ${index + 1}.`),
      ].join("\n\n"),
      onViewStateChange: vi.fn(),
    });

    const container = renderInto(props);
    const stickyChrome = expectElement(container, ".dreams-diary__chrome");
    const navigation = expectElement(stickyChrome, ".dreams-diary__daychips");
    const buttons = [...navigation.querySelectorAll<HTMLButtonElement>(".dreams-diary__day-chip")];

    expect(buttons.map((button) => compactText(button))).toEqual(labels);
    expect(
      container.querySelector(
        `${tab === "dreams" ? "#dream-diary-panel" : "#memory-wiki-panel"} .dreams-diary__daychips`,
      ),
    ).toBeNull();

    buttons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(viewState.diaryPage).toBe(1);
    expect(props.onViewStateChange).toHaveBeenCalledOnce();
  });

  it("keeps the Wiki document list free of cluster daychip navigation", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("wiki");
    const props = buildProps();
    const wikiOverview = expectDefined(props.wikiOverview, "wiki overview");
    const firstCluster = expectDefined(wikiOverview.clusters[0], "first memory wiki cluster");
    props.wikiOverview = {
      ...wikiOverview,
      clusters: [...wikiOverview.clusters, { ...firstCluster, key: "concept", label: "Concepts" }],
    };

    const container = renderInto(props);
    expect(container.querySelector(".dreams-diary__daychips")).toBeNull();
    expect(container.querySelectorAll("[data-wiki-page]")).toHaveLength(2);
  });

  it("renders diary empty, error, and removed-navigation states", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("dreams");
    const emptyContainer = renderInto(buildProps({ dreamDiaryContent: null }));
    expect(emptyContainer.querySelectorAll(".dreams-diary__empty")).toHaveLength(1);
    expect(emptyContainer.querySelector(".dreams-diary__empty-text")?.textContent).toBe(
      "No dreams yet",
    );
    expect(emptyContainer.querySelector(".dreams-diary__empty-hint")?.textContent).toBe(
      "Dreams will appear here after the first dreaming cycle runs.",
    );

    const errorContainer = renderInto(buildProps({ dreamDiaryError: "read failed" }));
    expect(errorContainer.querySelector(".dreams-diary__error")?.textContent).toBe("read failed");

    const container = renderInto(buildProps());
    expect(container.querySelector(".dreams-diary__page")).toBeNull();
    expect(container.querySelector(".dreams-diary__nav-btn")).toBeNull();
    setDreamSubTab("scene");
  });

  it("renders operator actions and evidence lists on the advanced tab", () => {
    setDreamSubTab("advanced");
    setDreamAdvancedWaitingSort("recent");
    const container = renderInto(buildProps());
    expect(container.querySelector(".dreams-advanced__title")?.textContent).toBe(
      "Daily Log Review",
    );
    const actionButtons = [...container.querySelectorAll(".dreams-advanced__actions button")].map(
      (node) => node.textContent?.trim(),
    );
    expect(actionButtons).toEqual([
      "Dedupe Diary",
      "Repair Dream Cache",
      "Backfill",
      "Reset",
      "Clear Replayed",
    ]);
    const sortButtons = [...container.querySelectorAll(".dreams-advanced__sort-btn")].map((node) =>
      node.textContent?.trim(),
    );
    expect(sortButtons).toEqual(["Most recent", "Strongest support"]);
    const sectionTitles = [...container.querySelectorAll(".dreams-advanced__section-title")].map(
      (node) => node.textContent?.trim(),
    );
    expect(sectionTitles).toEqual([
      "From the Daily Log",
      "Waiting for Promotion",
      "Recent Promotions",
    ]);
    expect(compactText(container.querySelector(".dreams-advanced__summary"))).toBe(
      "1 from daily log · 47 waiting · 12 promoted today",
    );
    expect(
      container.querySelector(".dreams-advanced__item .dreams-advanced__snippet")?.textContent,
    ).toBe("Emma prefers shorter, lower-pressure check-ins.");
    setDreamAdvancedWaitingSort("recent");
    setDreamSubTab("scene");
  });

  it("sorts waiting entries by strongest support without swapping datasets", () => {
    setDreamSubTab("advanced");
    const shortTermEntries = [
      {
        key: "memory:recent-low-signal",
        path: "memory/2026-04-05.md",
        startLine: 1,
        endLine: 1,
        snippet: "Recent but low signal",
        recallCount: 1,
        dailyCount: 0,
        groundedCount: 0,
        totalSignalCount: 1,
        lightHits: 0,
        remHits: 0,
        phaseHitCount: 0,
        lastRecalledAt: "2026-04-06T12:00:00.000Z",
      },
      {
        key: "memory:older-high-signal",
        path: "memory/2026-04-01.md",
        startLine: 1,
        endLine: 1,
        snippet: "Older but strongly supported",
        recallCount: 5,
        dailyCount: 4,
        groundedCount: 0,
        totalSignalCount: 9,
        lightHits: 2,
        remHits: 1,
        phaseHitCount: 3,
        lastRecalledAt: "2026-04-01T12:00:00.000Z",
      },
    ];

    setDreamAdvancedWaitingSort("recent");
    let container = renderInto(
      buildProps({
        shortTermEntries,
        promotedEntries: [],
      }),
    );
    const recentOrder = [...container.querySelectorAll("[data-entry-key]")].map((node) =>
      node.getAttribute("data-entry-key"),
    );
    expect(recentOrder).toEqual(["memory:recent-low-signal", "memory:older-high-signal"]);

    setDreamAdvancedWaitingSort("signals");
    container = renderInto(
      buildProps({
        shortTermEntries,
        promotedEntries: [],
      }),
    );
    const signalOrder = [...container.querySelectorAll("[data-entry-key]")].map((node) =>
      node.getAttribute("data-entry-key"),
    );
    expect(signalOrder).toEqual(["memory:older-high-signal", "memory:recent-low-signal"]);
    expect(new Set(signalOrder)).toEqual(new Set(recentOrder));

    setDreamAdvancedWaitingSort("recent");
    setDreamSubTab("scene");
  });

  it("treats malformed waiting-entry timestamps as oldest in both sort modes", () => {
    setDreamSubTab("advanced");
    const shortTermEntries = [
      {
        key: "memory:valid-recent",
        path: "memory/2026-04-06.md",
        startLine: 1,
        endLine: 1,
        snippet: "Valid recent timestamp",
        recallCount: 1,
        dailyCount: 0,
        groundedCount: 0,
        totalSignalCount: 3,
        lightHits: 1,
        remHits: 0,
        phaseHitCount: 1,
        lastRecalledAt: "2026-04-06T12:00:00.000Z",
      },
      {
        key: "memory:malformed-time",
        path: "memory/2026-04-05.md",
        startLine: 1,
        endLine: 1,
        snippet: "Malformed timestamp",
        recallCount: 1,
        dailyCount: 0,
        groundedCount: 0,
        totalSignalCount: 3,
        lightHits: 1,
        remHits: 0,
        phaseHitCount: 1,
        lastRecalledAt: "not-a-timestamp",
      },
    ];

    setDreamAdvancedWaitingSort("recent");
    let container = renderInto(
      buildProps({
        shortTermEntries,
        promotedEntries: [],
      }),
    );
    const recentOrder = [...container.querySelectorAll("[data-entry-key]")].map((node) =>
      node.getAttribute("data-entry-key"),
    );
    expect(recentOrder).toEqual(["memory:valid-recent", "memory:malformed-time"]);

    setDreamAdvancedWaitingSort("signals");
    container = renderInto(
      buildProps({
        shortTermEntries,
        promotedEntries: [],
      }),
    );
    const signalOrder = [...container.querySelectorAll("[data-entry-key]")].map((node) =>
      node.getAttribute("data-entry-key"),
    );
    expect(signalOrder).toEqual(["memory:valid-recent", "memory:malformed-time"]);

    setDreamAdvancedWaitingSort("recent");
    setDreamSubTab("scene");
  });

  // Toggle lives in the route header, not inside the dreaming view.
});
