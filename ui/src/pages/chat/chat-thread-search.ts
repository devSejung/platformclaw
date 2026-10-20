import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionSearchTarget } from "../../lib/session-search-navigation.ts";
import {
  searchSessionTranscripts,
  type SessionTranscriptSearchHit,
} from "../../lib/session-transcript-search.ts";

export type ChatThreadSearchBinding = {
  agentId?: string;
  sessionKey: string;
  sessionId?: string;
  client?: GatewayBrowserClient | null;
  onResult?: (target: SessionSearchTarget) => void;
  onInvalidate?: () => void;
  requestUpdate: () => void;
};

const SEARCH_PAGE_SIZE = 25;

/** Pane-owned find state; late replies cannot adopt a replacement transcript. */
export class ChatThreadSearch {
  open = false;
  query = "";
  loading = false;
  error = false;
  partial = false;
  total = 0;
  index = -1;
  input: HTMLInputElement | null = null;
  private binding: ChatThreadSearchBinding | null = null;
  private results: SessionTranscriptSearchHit[] = [];
  private offset = 0;
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private returnFocus: HTMLElement | null = null;
  private focusPending = false;

  bind(binding: ChatThreadSearchBinding): void {
    const previous = this.binding;
    this.binding = binding;
    if (
      previous &&
      (previous.agentId !== binding.agentId ||
        previous.sessionKey !== binding.sessionKey ||
        previous.sessionId !== binding.sessionId)
    ) {
      this.close(false);
    } else if (this.open && this.query.trim() && previous?.client !== binding.client) {
      void this.load(0, 0);
    }
  }

  show(requestUpdate: () => void): void {
    if (!this.open) {
      this.returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    this.open = true;
    this.focusPending = true;
    this.focusInput();
    requestUpdate();
  }

  readonly setInput = (element?: Element): void => {
    this.input = element instanceof HTMLInputElement ? element : null;
    queueMicrotask(() => this.focusInput());
  };

  private focusInput(): void {
    if (!this.focusPending || !this.input?.isConnected) {
      return;
    }
    this.focusPending = false;
    this.input.focus({ preventScroll: true });
    this.input.select();
  }

  close(restoreFocus = true): void {
    if (this.open) {
      this.binding?.onInvalidate?.();
    }
    this.version += 1;
    clearTimeout(this.timer);
    this.open = false;
    this.query = "";
    this.loading = false;
    this.error = false;
    this.partial = false;
    this.results = [];
    this.total = 0;
    this.index = -1;
    this.focusPending = false;
    if (restoreFocus && this.returnFocus?.isConnected) {
      this.returnFocus.focus({ preventScroll: true });
    }
    this.returnFocus = null;
    this.binding?.requestUpdate();
  }

  change(query: string): void {
    this.binding?.onInvalidate?.();
    this.version += 1;
    clearTimeout(this.timer);
    this.query = query;
    this.results = [];
    this.total = 0;
    this.index = -1;
    this.error = false;
    this.partial = false;
    this.loading = Boolean(query.trim());
    this.binding?.requestUpdate();
    if (query.trim()) {
      this.timer = setTimeout(() => void this.load(0, 0), 180);
    }
  }

  move(direction: 1 | -1): void {
    if (this.loading || this.total === 0) {
      return;
    }
    const next = (this.index + direction + this.total) % this.total;
    const hit = this.results[next - this.offset];
    if (hit) {
      this.index = next;
      this.reveal(hit);
      this.binding?.requestUpdate();
    } else {
      void this.load(Math.floor(next / SEARCH_PAGE_SIZE) * SEARCH_PAGE_SIZE, next);
    }
  }

  retry(): void {
    clearTimeout(this.timer);
    void this.load(0, 0);
  }

  private reveal(hit: SessionTranscriptSearchHit): void {
    this.binding?.onResult?.({ ...hit, query: this.query.trim() });
  }

  private async load(offset: number, selected: number): Promise<void> {
    const binding = this.binding;
    const query = this.query.trim();
    if (!binding?.client || !query || !this.open) {
      this.loading = false;
      this.error = Boolean(query);
      binding?.requestUpdate();
      return;
    }
    const version = ++this.version;
    this.loading = true;
    this.error = false;
    binding.requestUpdate();
    try {
      const response = await searchSessionTranscripts(binding.client, {
        query,
        ...(binding.agentId ? { agentId: binding.agentId } : {}),
        sessionKeys: [binding.sessionKey],
        sessionId: binding.sessionId,
        offset,
        limit: SEARCH_PAGE_SIZE,
      });
      if (version !== this.version || !this.open) {
        return;
      }
      this.results = response.results;
      this.offset = offset;
      this.total = response.totalCount ?? response.results.length;
      this.partial = Boolean(response.indexing);
      this.index = this.total ? Math.min(selected, this.total - 1) : -1;
      const hit = this.results[this.index - offset];
      if (hit) {
        this.reveal(hit);
      }
    } catch {
      if (version === this.version) {
        this.error = true;
      }
    } finally {
      if (version === this.version) {
        this.loading = false;
        binding.requestUpdate();
      }
    }
  }
}
