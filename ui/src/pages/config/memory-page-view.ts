import { html, type TemplateResult } from "lit";
import type { ConfigRouteData } from "./route-data.ts";

export type MemoryPageProps = {
  configObject: Record<string, unknown>;
  mutationDisabled: boolean;
  pluginsHref: string;
  memoryImportHref: string;
  routeData: ConfigRouteData | null;
  buildEditor: (keys: readonly string[]) => TemplateResult;
};

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
