/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "./context.ts";
import "./app-host.ts";

type HostedShellState = HTMLElement & {
  runtime: { context: ApplicationContext; shellSession: object };
  commandPaletteElement: {
    tagName: string;
    label: string;
    loadModule: () => Promise<unknown>;
  };
  handleDocumentKeydown: (event: KeyboardEvent) => void;
};

describe("PlatformClaw hosted shell", () => {
  it("does not handle the command palette shortcut", () => {
    const tagName = "openclaw-platformclaw-hosted-command-palette";
    const shell = document.createElement("openclaw-app-shell") as HostedShellState;
    shell.commandPaletteElement = {
      tagName,
      label: "hosted command palette",
      loadModule: async () => {
        customElements.define(tagName, class extends HTMLElement {});
      },
    };
    shell.runtime = { context: {} as ApplicationContext, shellSession: {} };
    const event = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      cancelable: true,
    });

    shell.handleDocumentKeydown(event);

    expect(event.defaultPrevented).toBe(false);
    expect(customElements.get(tagName)).toBeUndefined();
  });
});
