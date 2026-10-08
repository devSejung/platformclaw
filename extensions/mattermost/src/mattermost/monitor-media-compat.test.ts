import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import { buildMattermostInboundMediaPayload } from "./monitor-resources.js";

describe("Mattermost media at the public context boundary", () => {
  it("preserves attachment positions and path-backed URLs after finalization", async () => {
    const payload = await buildMattermostInboundMediaPayload([
      { path: "/tmp/image.png", contentType: "image/png", kind: "image" },
      { kind: "audio" },
    ]);
    const context = finalizeInboundContext({ Body: "caption", ...payload });

    // The current public finalizer folds the legacy projection back into facts.
    // Dropping the producer projection alone changes URL and type values for readers.
    expect(context.media).toEqual([
      {
        path: "/tmp/image.png",
        url: "/tmp/image.png",
        contentType: "image/png",
        kind: "image",
        transcribed: false,
      },
      { contentType: "audio", kind: "audio", transcribed: false },
    ]);
    expect(context).toMatchObject({
      MediaPath: "/tmp/image.png",
      MediaUrl: "/tmp/image.png",
      MediaType: "image/png",
      MediaPaths: ["/tmp/image.png", ""],
      MediaUrls: ["/tmp/image.png", ""],
      MediaTypes: ["image/png", "audio"],
      MediaTranscribedIndexes: undefined,
    });
  });

  it("preserves type-only attachments when every download fails", async () => {
    const payload = await buildMattermostInboundMediaPayload([
      { kind: "video" },
      { contentType: "application/pdf", kind: "document" },
    ]);
    const context = finalizeInboundContext({ Body: "attachments unavailable", ...payload });

    expect(context.media).toEqual([
      { contentType: "video", kind: "video", transcribed: false },
      { contentType: "application/pdf", kind: "document", transcribed: false },
    ]);
    expect(context).toMatchObject({
      MediaPath: undefined,
      MediaUrl: undefined,
      MediaType: "video",
      MediaPaths: undefined,
      MediaUrls: undefined,
      MediaTypes: ["video", "application/pdf"],
      MediaTranscribedIndexes: undefined,
    });
  });
});
