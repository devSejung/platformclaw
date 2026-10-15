import { WebSocket } from "ws";
import { logRejectedLargePayload } from "../../../logging/diagnostic-payload.js";
import { MAX_BUFFERED_BYTES } from "../../server-constants.js";

/** Owns response buffering and the actual WebSocket write/terminal completion boundary. */
export function createGatewayWsResponseSender(params: {
  socket: WebSocket;
  isClosed: () => boolean;
  close: (code?: number, reason?: string) => void;
  setCloseCause: (cause: string, meta?: Record<string, unknown>) => void;
  connectionKind: "gateway" | "worker";
}) {
  const { socket, isClosed, close, setCloseCause, connectionKind } = params;
  return (obj: unknown, onComplete?: (error?: Error) => void) => {
    let settled = false;
    const complete = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.off("close", onClose);
      socket.off("error", onError);
      onComplete?.(error);
    };
    const onClose = () => complete(new Error("Gateway socket closed before response completion"));
    const onError = (error: Error) => complete(error);
    if (isClosed() || socket.readyState !== WebSocket.OPEN) {
      complete(new Error("Gateway socket is closed"));
      return;
    }
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      logRejectedLargePayload({
        surface: "gateway.ws.outbound_buffer",
        bytes: socket.bufferedAmount,
        limitBytes: MAX_BUFFERED_BYTES,
        reason: "ws_send_buffer_close",
      });
      setCloseCause("outbound-buffer-exceeded", {
        bytes: socket.bufferedAmount,
        limitBytes: MAX_BUFFERED_BYTES,
      });
      close(1008, connectionKind === "worker" ? "slow-consumer" : "slow consumer");
      complete(new Error("Gateway outbound buffer exceeded"));
      return;
    }
    if (onComplete) {
      socket.once("close", onClose);
      socket.once("error", onError);
    }
    try {
      const frame = JSON.stringify(obj);
      if (onComplete) {
        socket.send(frame, complete);
      } else {
        socket.send(frame);
      }
    } catch (error) {
      complete(error instanceof Error ? error : new Error("Gateway response send failed"));
    }
  };
}
