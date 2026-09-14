// Pure public grammar boundary: no vault, compiler, config, or host runtime imports.
export {
  MAX_MEMORY_WIKI_REFERENCE_SPANS,
  parseMemoryWikiReferenceSpans,
  memoryWikiPromotionRevision,
  memoryWikiReferenceTextHash,
  type MemoryWikiReferenceSpan,
} from "./src/reference-spans.js";
