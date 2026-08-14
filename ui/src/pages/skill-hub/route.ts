import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("skill-hub"),
  component: () =>
    import("./skill-hub-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-skill-hub-page></openclaw-skill-hub-page>`,
    })),
});
