import { randomUUID } from "node:crypto";
import { ORGANIZATION_KNOWLEDGE_POLICY_VERSION } from "./organization-knowledge-analysis.js";
import type { OrganizationKnowledgeAnalyzer } from "./organization-memory-knowledge-contracts.js";
import type { OrganizationPromotionKnowledgeComparison } from "./organization-memory-knowledge-contracts.js";
import type { SqliteControlPlaneStore } from "./sqlite-store.js";

/** Explicit requests own work; reading reports never starts model analysis. */
export class OrganizationKnowledgeService {
  private readonly owner = `knowledge-worker-${randomUUID()}`;
  private running: Promise<void> | undefined;
  private closed = false;
  private needsKick = false;
  private controller: AbortController | undefined;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: SqliteControlPlaneStore,
    private readonly analyze: OrganizationKnowledgeAnalyzer,
    private readonly now: () => number = Date.now,
  ) {}

  kick(): void {
    if (this.closed) {
      return;
    }
    if (this.running) {
      this.needsKick = true;
      return;
    }
    this.needsKick = false;
    clearTimeout(this.wakeTimer);
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (this.needsKick) {
        this.kick();
      }
    });
    // Job failures are durably recorded by drain; keep background errors out of
    // the browser request promise without emitting private model payloads.
    void this.running.catch(() => {});
  }

  async generate(params: { agentId: string; scopeId: string; requestId: string; force?: boolean }) {
    const result = await this.store.enqueueOrganizationKnowledge({ ...params, now: this.now() });
    this.kick();
    return result;
  }

  async comparePromotion(params: {
    agentId: string;
    requestId: string;
  }): Promise<OrganizationPromotionKnowledgeComparison> {
    const prepared = await this.store.preparePromotionKnowledgeComparison(params);
    if (prepared.cached) {
      return prepared.cached;
    }
    if (!prepared.input) {
      return {
        status: "unavailable",
        reason: "Related comparison is unavailable; approval remains available.",
      };
    }
    const input = prepared.input;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240_000);
    try {
      const candidate = input.claims[0]!;
      const comparisons = [];
      for (const target of input.claims.slice(1)) {
        const analysis = await this.analyze(
          { ...input, claims: [candidate, target] },
          controller.signal,
        );
        comparisons.push(...analysis.comparisons);
      }
      return await this.store.savePromotionKnowledgeComparison({
        ...params,
        input,
        now: this.now(),
        analysis: {
          summary: `Compared ${comparisons.length} bounded submitted-to-approved candidate pairs. Candidate retrieval may omit other related knowledge. Recommendations are informational and never reject or approve a submission automatically.`,
          comparisons,
          coverage: {
            strategy: "candidate-pairs",
            policyVersion: ORGANIZATION_KNOWLEDGE_POLICY_VERSION,
            candidatePairs: input.claims.length - 1,
            comparedPairs: comparisons.length,
            hasUncomparedPairs:
              comparisons.length < (input.claims.length * (input.claims.length - 1)) / 2,
          },
        },
      });
    } catch {
      return {
        status: "unavailable",
        reason: "Analysis did not complete; submission and approval remain available.",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      const job = await this.store.claimOrganizationKnowledgeJob({
        owner: this.owner,
        now: this.now(),
      });
      if (!job) {
        const expiry = await this.store.nextOrganizationKnowledgeLeaseExpiry();
        // One lifecycle timer observes a crash-left lease without failing a
        // still-live other process on startup. There is no scheduled analysis.
        if (!this.closed && expiry !== null) {
          this.wakeTimer = setTimeout(() => this.kick(), Math.max(1, expiry - this.now()));
        }
        return;
      }
      if (!job.input) {
        continue;
      }
      this.controller = new AbortController();
      const timer = setTimeout(() => this.controller?.abort(), 240_000);
      try {
        const signal = this.controller.signal;
        const analysis = await Promise.race([
          this.analyze(job.input, signal),
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("analysis cancelled")), {
              once: true,
            });
          }),
        ]);
        await this.store.finishOrganizationKnowledgeJob({
          jobId: job.jobId,
          owner: this.owner,
          now: this.now(),
          analysis,
        });
      } catch {
        await this.store.failOrganizationKnowledgeJob({
          jobId: job.jobId,
          owner: this.owner,
          now: this.now(),
          code: this.controller.signal.aborted ? "analysis-cancelled" : "analysis-failed",
        });
      } finally {
        clearTimeout(timer);
        this.controller = undefined;
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.wakeTimer);
    this.controller?.abort();
    await this.running;
  }
}
