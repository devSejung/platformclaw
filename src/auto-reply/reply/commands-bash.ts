// Implements bash command execution, approval, and stop handling.
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { handleBashChatCommand } from "./bash-command.js";
import { commandReply, defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

export const handleBashCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/bash",
    match: (body, params) =>
      matchCommandPrefix(body, "/bash") !== null ||
      (body.startsWith("!") && params.command.isAuthorizedSender)
        ? true
        : null,
  },
  async (params) => {
    // Unlike project tools, chat shell shortcuts share host-level process state.
    // A delegated personal Agent must not inherit it from its service connection.
    if (isInternalMessageChannel(params.ctx.Provider) && params.ctx.SenderIsOwner === false) {
      return commandReply(
        "Shell shortcuts require Gateway-owner authority. Use your Agent's project tools instead.",
      );
    }
    const agentId = params.sessionKey
      ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
      : params.agentId;
    const reply = await handleBashChatCommand({
      ctx: params.ctx,
      cfg: params.cfg,
      agentId,
      sessionKey: params.sessionKey,
      isGroup: params.isGroup,
      elevated: params.elevated,
    });
    return { shouldContinue: false, reply };
  },
);
