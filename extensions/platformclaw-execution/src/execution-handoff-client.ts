import { request } from "node:http";
import path from "node:path";

const MAX_HANDOFF_RESPONSE_BYTES = 512 * 1024;

export function executionHandoffAddress(credentialBrokerAddress: string): string {
  return process.platform === "win32"
    ? `${credentialBrokerAddress}-execution`
    : path.join(path.dirname(credentialBrokerAddress), "execution.sock");
}

export async function callExecutionHandoff(params: {
  socketPath: string;
  serviceToken: string;
  path: string;
  body: unknown;
}): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify(params.body));
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const req = request(
      {
        socketPath: params.socketPath,
        path: params.path,
        method: "POST",
        headers: {
          authorization: `Bearer ${params.serviceToken}`,
          "content-type": "application/json",
          "content-length": payload.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_HANDOFF_RESPONSE_BYTES) {
            const error = new Error("execution target response exceeded the limit");
            fail(error);
            req.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        res.once("end", () => {
          if (settled) {
            return;
          }
          const status = res.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            fail(new Error(`execution target request failed (${status})`));
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            settled = true;
            resolve(parsed);
          } catch {
            fail(new Error("execution target response is invalid"));
          }
        });
        res.once("aborted", () => fail(new Error("execution target response was aborted")));
        res.once("error", fail);
      },
    );
    req.setTimeout(5_000, () => req.destroy(new Error("execution target request timed out")));
    req.once("error", fail);
    req.end(payload);
  });
}
