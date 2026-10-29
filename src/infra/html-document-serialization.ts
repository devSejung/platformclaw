export type HtmlSerializableElement = {
  readonly attributes: Iterable<{ value: string }>;
  readonly children: Iterable<HtmlSerializableElement>;
};

export type HtmlSerializableDocument = {
  readonly children: Iterable<HtmlSerializableElement>;
  toString(): string;
};

/** Preserve HTML attribute values across LinkeDOM serialization and browser parsing. */
export function serializeHtmlDocument(document: HtmlSerializableDocument): string {
  const originals: Array<{ attribute: { value: string }; value: string }> = [];
  const elements = [...document.children];
  try {
    // HTML Attr serialization escapes quotes but not ampersands. Traverse the
    // physical tree so template children, skipped by selectors, are included
    // exactly once. Keep caller-owned values unchanged after serialization.
    for (const element of elements) {
      for (const attribute of element.attributes) {
        const value = attribute.value;
        if (value.includes("&")) {
          originals.push({ attribute, value });
          attribute.value = value.replaceAll("&", "&amp;");
        }
      }
      for (const child of element.children) {
        elements.push(child);
      }
    }
    return document.toString();
  } finally {
    for (const { attribute, value } of originals) {
      attribute.value = value;
    }
  }
}
