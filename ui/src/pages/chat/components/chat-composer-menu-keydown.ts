import { resetSkillMenuState } from "./chat-composer-skill-menu.ts";
import { resetSlashMenuState } from "./chat-composer-slash-menu.ts";
import type { ChatComposerState } from "./chat-composer-types.ts";

export function handleComposerMenuKeyDown<T>(
  event: KeyboardEvent,
  state: ChatComposerState,
  items: readonly T[],
  paneId: string,
  requestUpdate: () => void,
  onSelect: (item: T, submit: boolean) => void,
  scrollActive: (state: ChatComposerState, paneId: string) => void,
  menu: "slash" | "skill" = "slash",
): boolean {
  if (event.key === "Escape") {
    event.preventDefault();
    if (menu === "skill") {
      resetSkillMenuState(state);
    } else {
      state.slashMenuOpen = false;
      resetSlashMenuState(state);
    }
    requestUpdate();
    return true;
  }
  if (items.length === 0) {
    if (
      menu === "skill" &&
      state.skillCommandRefreshPending &&
      ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)
    ) {
      event.preventDefault();
      return true;
    }
    return false;
  }
  const indexKey = menu === "skill" ? "skillMenuIndex" : "slashMenuIndex";
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp": {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : items.length - 1;
      state[indexKey] = (state[indexKey] + offset) % items.length;
      requestUpdate();
      scrollActive(state, paneId);
      return true;
    }
    case "Tab":
    case "Enter": {
      event.preventDefault();
      const item = items[state[indexKey]];
      if (item !== undefined) {
        onSelect(item, event.key === "Enter");
      }
      return true;
    }
    default:
      return false;
  }
}
