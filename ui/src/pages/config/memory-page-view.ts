import { html } from "lit";
import type { MemoryPageProps } from "./memory-page.ts";

export function renderMemoryPageElement(props: MemoryPageProps) {
  return html`<openclaw-memory-settings
    .configObject=${props.configObject}
    .mutationDisabled=${props.mutationDisabled}
    .pluginsHref=${props.pluginsHref}
    .memoryImportHref=${props.memoryImportHref}
    .routeData=${props.routeData}
    .buildEditor=${props.buildEditor}
  ></openclaw-memory-settings>`;
}
