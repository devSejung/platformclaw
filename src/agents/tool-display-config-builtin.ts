/** Display metadata for built-in execution and filesystem tools. */
export const BUILTIN_TOOL_DISPLAY_CONFIG = {
  bash: {
    emoji: "🛠️",
    title: "Bash",
    detailKeys: ["command"],
  },
  computer: {
    emoji: "🖱️",
    title: "Computer",
    detailKeys: ["action", "coordinate", "text", "node", "nodeId", "screenIndex"],
  },
  mobile_ui: {
    emoji: "📱",
    title: "Mobile UI",
    detailKeys: ["action", "mobileAction", "snapshotId", "node", "nodeId"],
  },
  screen: {
    emoji: "🖥️",
    title: "Screen",
    detailKeys: ["action", "sessionKey", "dock"],
  },
  terminal: {
    emoji: "⌨️",
    title: "Terminal",
    detailKeys: ["action", "sessionId", "command", "cwd"],
  },
  process: {
    emoji: "🧰",
    title: "Process",
    detailKeys: ["sessionId"],
  },
  read: {
    emoji: "📖",
    title: "Read",
    detailKeys: ["path"],
  },
  write: {
    emoji: "✍️",
    title: "Write",
    detailKeys: ["path"],
  },
  edit: {
    emoji: "📝",
    title: "Edit",
    detailKeys: ["path"],
  },
};
