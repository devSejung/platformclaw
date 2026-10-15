import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArcadeInputController } from "./easter-egg-controls.ts";

describe("baseball keyboard and pointer input", () => {
  let controller: ArcadeInputController;
  let host: HTMLElement;
  let game: HTMLElement;
  let player: HTMLElement;
  let active: boolean;
  let selector: boolean;
  let shopOpen: boolean;
  const swing = vi.fn();

  const key = (
    type: string,
    code: string,
    options: KeyboardEventInit = {},
    target: EventTarget = game,
  ) => {
    const event = new KeyboardEvent(type, {
      key: code.startsWith("Control") ? "Control" : code,
      code,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    target.dispatchEvent(event);
    return event;
  };
  const pointer = (type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, clientX: 110, clientY: window.innerHeight - 10 });
    player.dispatchEvent(event);
  };

  beforeEach(() => {
    host = document.createElement("div");
    game = document.createElement("div");
    game.tabIndex = -1;
    game.setAttribute("role", "application");
    player = document.createElement("div");
    game.append(player);
    host.append(game);
    document.body.replaceChildren(host);
    game.focus();
    active = true;
    selector = false;
    shopOpen = false;
    swing.mockClear();
    vi.spyOn(player, "getBoundingClientRect").mockReturnValue({ left: 100, right: 134 } as DOMRect);
    controller = new ArcadeInputController({
      host,
      active: () => active,
      selector: () => selector,
      shopOpen: () => shopOpen,
      player: () => player,
      swing,
      closeShop: vi.fn(),
      close: vi.fn(),
    });
    controller.connect();
  });
  afterEach(() => {
    controller.disconnect();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it.each(["ControlLeft", "ControlRight"])(
    "swings immediately on %s keydown and leaves browser defaults intact",
    (code) => {
      const down = key("keydown", code, { ctrlKey: true });
      expect(swing).toHaveBeenCalledOnce();
      expect(swing).toHaveBeenCalledWith(down);
      expect(down.defaultPrevented).toBe(false);
      const up = key("keyup", code);
      expect(swing).toHaveBeenCalledOnce();
      expect(up.defaultPrevented).toBe(false);
    },
  );

  it("swings only once while either Control key is held, including duplicate and repeat events", () => {
    key("keydown", "ControlLeft");
    key("keydown", "ControlLeft");
    key("keydown", "ControlLeft", { repeat: true });
    key("keydown", "ControlRight");
    key("keyup", "ControlLeft");
    key("keydown", "ControlRight");
    expect(swing).toHaveBeenCalledOnce();
    key("keyup", "ControlRight");
    key("keydown", "ControlRight");
    expect(swing).toHaveBeenCalledTimes(2);
  });

  it.each(["KeyC", "KeyV", "Space", "Tab", "Escape"])(
    "does not prevent %s browser shortcuts after the initial Control swing",
    (code) => {
      key("keydown", "ControlLeft", { ctrlKey: true });
      const shortcut = key("keydown", code, {
        ctrlKey: true,
        key: code === "KeyC" ? "c" : code === "KeyV" ? "v" : code,
      });
      expect(swing).toHaveBeenCalledOnce();
      expect(shortcut.defaultPrevented).toBe(false);
    },
  );

  it.each(["input", "textarea", "editable"])(
    "ignores Control in %s, including a window-dispatched event while it is focused",
    (kind) => {
      const input = document.createElement(kind === "editable" ? "div" : kind);
      if (kind === "editable") {
        input.setAttribute("contenteditable", "true");
        input.tabIndex = 0;
      }
      game.append(input);
      input.focus();
      key("keydown", "ControlLeft", {}, input);
      key("keyup", "ControlLeft", {}, input);
      key("keydown", "ControlLeft", {}, window);
      expect(swing).not.toHaveBeenCalled();
    },
  );

  it.each(["inactive", "selector", "shop", "outside", "unfocused"])(
    "ignores Control when %s",
    (state) => {
      if (state === "inactive") {
        active = false;
      }
      if (state === "selector") {
        selector = true;
      }
      if (state === "shop") {
        shopOpen = true;
      }
      if (state === "outside") {
        const outside = document.createElement("button");
        document.body.append(outside);
        outside.focus();
      }
      if (state === "unfocused") {
        vi.spyOn(document, "hasFocus").mockReturnValue(false);
      }
      key("keydown", "ControlLeft", {}, window);
      expect(swing).not.toHaveBeenCalled();
    },
  );

  it("clears held input on blur without swinging on the subsequent keyup", () => {
    key("keydown", "ControlLeft");
    window.dispatchEvent(new Event("blur"));
    key("keyup", "ControlLeft");
    expect(swing).toHaveBeenCalledOnce();
    key("keydown", "ControlLeft");
    expect(swing).toHaveBeenCalledTimes(2);
  });

  it("preserves Space and pointer-up swings and cancels unfinished pointer gestures", () => {
    key("keydown", "Space");
    key("keydown", "Space", { repeat: true });
    expect(swing).toHaveBeenCalledOnce();
    pointer("pointerdown");
    expect(swing).toHaveBeenCalledOnce();
    pointer("pointerup");
    expect(swing).toHaveBeenCalledTimes(2);
    pointer("pointerdown");
    pointer("pointercancel");
    pointer("pointerup");
    expect(swing).toHaveBeenCalledTimes(2);
  });

  it.each(["pointerup", "pointercancel"])("keeps held Control keys independent of %s", (ending) => {
    key("keydown", "ControlLeft");
    pointer("pointerdown");
    pointer(ending);
    const beforeRight = ending === "pointerup" ? 2 : 1;
    expect(swing).toHaveBeenCalledTimes(beforeRight);
    key("keydown", "ControlRight");
    expect(swing).toHaveBeenCalledTimes(beforeRight);
    key("keyup", "ControlLeft");
    key("keyup", "ControlRight");
    key("keydown", "ControlRight");
    expect(swing).toHaveBeenCalledTimes(beforeRight + 1);
  });

  it("releases keyboard listeners when disconnected", () => {
    controller.disconnect();
    key("keydown", "ControlLeft");
    key("keydown", "Space");
    expect(swing).not.toHaveBeenCalled();
  });
});
