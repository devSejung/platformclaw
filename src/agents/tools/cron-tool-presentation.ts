import { isRecord } from "@openclaw/normalization-core/record-coerce";

export function formatCronTerminalPresentation(
  params: unknown,
  result: unknown,
): { text: string } | undefined {
  if (!isRecord(params) || !isRecord(result) || !isRecord(result.details)) {
    return undefined;
  }
  switch (params.action) {
    case "status": {
      const enabled = result.details.enabled === true ? "yes" : "no";
      return { text: `Automations scheduler status.\nEnabled: ${enabled}` };
    }
    case "list": {
      const total =
        typeof result.details.total === "number" &&
        Number.isFinite(result.details.total) &&
        result.details.total >= 0
          ? Math.floor(result.details.total)
          : undefined;
      const count =
        total ?? (Array.isArray(result.details.jobs) ? result.details.jobs.length : undefined);
      return count === undefined
        ? { text: "Automations listed." }
        : { text: `Automations listed.\nCount: ${count}` };
    }
    case "get":
      return { text: "Automation loaded." };
    case "runs": {
      const entries = Array.isArray(result.details.entries)
        ? result.details.entries.length
        : undefined;
      return entries === undefined
        ? { text: "Automation run history loaded." }
        : { text: `Automation run history loaded.\nCount: ${entries}` };
    }
    default:
      return undefined;
  }
}
