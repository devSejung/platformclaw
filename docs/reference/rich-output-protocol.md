---
summary: "Rich output protocol for structured media, embeds, audio hints, and replies"
read_when:
  - Changing assistant output rendering in the Control UI
  - Debugging `[embed ...]`, structured media, reply, or audio presentation directives
title: "Rich output protocol"
---

Assistant output carries delivery/render directives through a few dedicated channels:

- Structured `mediaUrl` / `mediaUrls` fields for attachment delivery.
- `[[audio_as_voice]]` for audio presentation hints.
- `[[reply_to_current]]` / `[[reply_to:<id>]]` for reply metadata.
- `[embed ...]` for Control UI rich rendering.

Structured media fields and `[[...]]` tags are delivery metadata. `[embed ...]` is the separate web-only rich-render path; it is not a media alias.

## Media attachments

Remote attachments must be public `https:` URLs. `http:`, loopback, link-local, private, and internal hostnames are rejected as attachment directives; server-side media fetchers apply their own network guards on top.

Local attachments accept absolute paths, workspace-relative paths, or home-relative `~/` paths. They still pass the agent file-read policy and media type checks before delivery.

<Warning>
Do not emit text commands for attachments from tools, plugins, streaming blocks, browser output, or message actions. Use structured media fields instead:

```json
{ "message": "Here is your image.", "mediaUrl": "/workspace/image.png" }
```

Legacy final-reply text may still be normalized for compatibility, but this is not a general plugin/tool protocol.
</Warning>

### Saved HTML previews

In web chat, an authorized HTML attachment offers **Preview** while preserving its
original download. Preview renders the saved attachment snapshot in an isolated
frame. It does not turn a server or VM path into a browser URL, start another model
turn, or grant widget prompt and dashboard APIs.

Create a self-contained HTML file in the active workspace. Use inline CSS,
JavaScript, and SVG, and `data:`/`blob:` images. Relative and external resources are
not bundled; unsupported static references are omitted from the preview with a
visible notice. The original attachment is unchanged.

In automatic visible-reply mode, attach the file with a standalone final-reply line:

```text
Here is the report. Choose Preview to view it.

MEDIA:/workspace/report.html
```

In message-tool-only mode, use the current source reply's structured `media` or
`attachments` fields instead of a `MEDIA:` line. Tools and plugins continue to use
structured attachment payloads. File-read, format, and delivery checks still apply;
neither form grants access merely because the path ends in `.html`.

Use [show widget](/tools/show-widget) for a separate inline visualization or dashboard
widget. A file preview does not require the model to repeat the HTML in a tool call.

## Legacy `MEDIA:` lines

In automatic visible-reply mode, legacy final assistant replies can still attach local media with a plain
standalone `MEDIA:` line. The parser only recognizes lines whose trimmed text
starts with `MEDIA:` outside Markdown wrappers and code fences.

Valid legacy final reply:

```text
Here is the generated image.

MEDIA:/workspace/image.png
```

These remain ordinary text and do not attach media:

```text
**MEDIA:/workspace/image.png**
`MEDIA:/workspace/image.png`
Here is your image: MEDIA:/workspace/image.png
```

Prefer structured `mediaUrl` / `mediaUrls` fields for tools, plugins, browser
output, streaming blocks, and message actions.

Plain Markdown image syntax stays text by default. Channels that intentionally
map Markdown image replies to media attachments opt in at their outbound
adapter; Telegram does this so `![alt](url)` can still become a media reply.

When block streaming is enabled, media must ride on structured payload fields. If the same media URL appears in a streamed block and again in the final assistant payload, OpenClaw delivers it once and strips the duplicate from the final payload.

## `[embed ...]`

`[embed ...]` is the only agent-facing rich-render syntax for the Control UI. Self-closing example:

```text
[embed ref="cv_123" title="Status" /]
```

Rules:

- `[view ...]` is no longer valid for new output.
- Embed shortcodes render only in the assistant message surface.
- Only URL-backed embeds render; use `ref="..."` or `url="..."`.
- Block-form inline HTML embed shortcodes do not render.
- The web UI strips the shortcode from visible text and renders the embed inline.

## Stored rendering shape

The normalized/stored assistant content block is a structured `canvas` item:

```json
{
  "type": "canvas",
  "preview": {
    "kind": "canvas",
    "surface": "assistant_message",
    "render": "url",
    "viewId": "cv_123",
    "url": "/__openclaw__/canvas/documents/cv_123/index.html",
    "title": "Status",
    "preferredHeight": 320
  }
}
```

`present_view` is not recognized; stored/rendered rich blocks always use this `canvas` shape.

## Related

- [RPC adapters](/reference/rpc)
- [Typebox](/concepts/typebox)
