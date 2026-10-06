import fs from "node:fs";
import path from "node:path";
import {
  purgeSessionArchiveReadCache,
  stripSessionArchiveCompressionSuffix,
} from "./archive-compression.js";
import { isSessionArchiveArtifactName } from "./artifacts.js";

/** Only canonical generation ownership authorizes removal; never scan transcript content for ids. */
export function purgeOwnedSessionTranscriptArtifacts(
  directory: string,
  sessionIds: readonly string[],
): void {
  const ids = new Set(sessionIds);
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const name of names) {
    const plain = stripSessionArchiveCompressionSuffix(name);
    const marker = plain.lastIndexOf(".jsonl");
    if (marker < 1 || !ids.has(plain.slice(0, marker))) {
      continue;
    }
    const sessionId = plain.slice(0, marker);
    if (name !== `${sessionId}.jsonl` && !isSessionArchiveArtifactName(name, sessionId)) {
      continue;
    }
    const filePath = path.join(directory, name);
    // Scrub the cache first: archive removal must not destroy the retry identity.
    purgeSessionArchiveReadCache(filePath);
    fs.rmSync(filePath, { force: true });
    // Catch a reader that published between the first scrub and source removal;
    // the producer's post-publication source check handles later readers.
    purgeSessionArchiveReadCache(filePath);
  }
}
