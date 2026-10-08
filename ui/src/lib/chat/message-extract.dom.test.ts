import { describe, expect, it } from "vitest";
import { readPersistedMediaFacts } from "../../../../src/media/media-facts-normalize.js";
import { extractText, readTranscriptMediaEntries } from "./message-extract.ts";

// Use the regular UI environment and real consumer graph: importing the Node
// MIME sniffer here used to prevent jsdom suites from collecting at all.
describe("browser transcript media normalization", () => {
  it("reads canonical attachment metadata and keeps the browser claim-check identity", () => {
    const message = {
      role: "user",
      content: "Listen to this recording",
      __openclaw: {
        media: [
          {
            path: "/srv/private/media/voice.ogg",
            url: "media://inbound/voice.ogg",
            contentType: " Audio/Ogg; codecs=opus ",
            fileName: " voice.ogg ",
            durationMs: 12_346,
          },
        ],
      },
    };

    expect(extractText(message)).toBe("Listen to this recording");
    expect(readTranscriptMediaEntries(message)).toEqual([
      {
        path: "media://inbound/voice.ogg",
        mediaType: "Audio/Ogg; codecs=opus",
        fileName: "voice.ogg",
      },
    ]);
    expect(readPersistedMediaFacts(message)).toEqual([
      expect.objectContaining({ kind: "audio", durationMs: 12_346 }),
    ]);
  });

  it("preserves generic MIME provenance and explicit media kinds", () => {
    const media = readPersistedMediaFacts({
      __openclaw: {
        media: [
          { path: "/media/scan.tiff", contentType: "application/octet-stream" },
          { path: "/media/sticker.bin", kind: "sticker" },
          { url: "https://example.test/image", contentType: " IMAGE/APNG " },
        ],
      },
    });

    expect(media?.map((fact) => fact.kind)).toEqual([undefined, "sticker", "image"]);
  });
});
