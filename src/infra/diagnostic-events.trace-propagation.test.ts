// Covers diagnostic emission trust and synchronous exporter trace preparation.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "./diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  formatDiagnosticTraceparent,
} from "./diagnostic-trace-context.js";
import {
  type DiagnosticTracePropagationBridge,
  formatPropagatedDiagnosticTraceparent,
  registerDiagnosticTracePropagationBridge,
} from "./diagnostic-trace-propagation.js";

describe("diagnostic event trace propagation", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("prepares trace propagation only for dispatcher-trusted events", () => {
    const trace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    });
    const prepared: Array<{ type: string; trusted: boolean }> = [];
    registerDiagnosticTracePropagationBridge({
      prepareEvent(event: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) {
        prepared.push({ type: event.type, trusted: metadata.trusted });
      },
      resolveTraceContext: (context) => context,
    });
    const traceparents: Array<{ traceparent: string | undefined; trusted: boolean }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      traceparents.push({
        traceparent: formatDiagnosticTraceparent(event.trace),
        trusted: metadata.trusted,
      });
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
      trace,
    });
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      usage: { total: 1 },
      trace,
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
      trace,
      trusted: true,
      trustedTraceContext: true,
    } as Parameters<typeof emitDiagnosticEvent>[0]);

    expect(prepared).toEqual([{ type: "model.usage", trusted: true }]);
    expect(traceparents).toEqual([
      { traceparent: `00-${trace.traceId}-${trace.spanId}-01`, trusted: false },
      { traceparent: `00-${trace.traceId}-${trace.spanId}-01`, trusted: true },
      { traceparent: `00-${trace.traceId}-${trace.spanId}-01`, trusted: false },
    ]);
  });

  it("prepares trusted events synchronously without cloning private data", async () => {
    const diagnosticTrace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    });
    const exportedTrace = createDiagnosticTraceContext({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceFlags: "00",
    });
    const prepared: string[] = [];
    let privateDataReads = 0;
    const bridge: DiagnosticTracePropagationBridge<
      DiagnosticEventPayload,
      DiagnosticEventMetadata
    > = {
      shouldPrepareEvent(event) {
        return event.type === "model.call.started";
      },
      prepareEvent(event) {
        prepared.push(event.type);
      },
      resolveTraceContext(traceContext) {
        expect(traceContext).toBe(diagnosticTrace);
        return exportedTrace;
      },
    };
    registerDiagnosticTracePropagationBridge(bridge);

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.started",
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: diagnosticTrace,
      },
      {
        modelContent: {
          get inputMessages() {
            privateDataReads += 1;
            return ["secret prompt"];
          },
        },
      },
    );
    expect(privateDataReads).toBe(0);
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 1,
      trace: diagnosticTrace,
    });

    expect(prepared).toEqual(["model.call.started"]);
    expect(formatDiagnosticTraceparent(diagnosticTrace)).toBe(
      `00-${diagnosticTrace.traceId}-${diagnosticTrace.spanId}-01`,
    );
    expect(formatPropagatedDiagnosticTraceparent(diagnosticTrace)).toBe(
      `00-${exportedTrace.traceId}-${exportedTrace.spanId}-00`,
    );
    await waitForDiagnosticEventsDrained();
    expect(privateDataReads).toBe(0);
  });

  it("does not fall back to diagnostic ids when an active propagation bridge misses", () => {
    const diagnosticTrace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    });
    registerDiagnosticTracePropagationBridge({
      resolveTraceContext: () => undefined,
    });

    expect(formatDiagnosticTraceparent(diagnosticTrace)).toBe(
      `00-${diagnosticTrace.traceId}-${diagnosticTrace.spanId}-01`,
    );
    expect(formatPropagatedDiagnosticTraceparent(diagnosticTrace)).toBeUndefined();
  });
});
