import {
  resolveMemoryCorpusScope,
  runMemoryWikiSupplementOperation,
  type MemoryWikiOperation,
  type MemoryWikiOperationResult,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawConfig } from "../api.js";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  createMemoryWikiDocument,
  getMemoryWikiDocument,
  saveMemoryWikiDocument,
  MemoryWikiEditValidationError,
  MemoryWikiEditConflictError,
} from "./document-edit.js";
import { lintMemoryWikiVault } from "./lint.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { resolveMemoryWikiStatus } from "./status.js";

async function runPersonalOperation(
  config: ResolvedMemoryWikiConfig,
  appConfig: OpenClawConfig | undefined,
  input: MemoryWikiOperation,
): Promise<MemoryWikiOperationResult> {
  const identity = {
    vaultId: `personal:${input.agentId ?? config.agentId ?? "main"}`,
    vaultName: "Personal Wiki",
    vaultType: "personal",
  };
  await syncMemoryWikiImportedSources({ config, appConfig });
  if (input.operation === "status") {
    const status = await resolveMemoryWikiStatus(config, {
      appConfig,
      callerAgentId: input.agentId,
    });
    const details = {
      ...identity,
      exists: status.vaultExists,
      pageCounts: status.pageCounts,
      compileFailure: status.compileFailure,
    };
    return {
      text: `${identity.vaultName} (${identity.vaultId}): ${Object.values(status.pageCounts).reduce((sum, count) => sum + count, 0)} documents. ${status.compileFailure ? `Index failed: ${status.compileFailure.error}. Last successful index retained; retry is scheduled. Use refresh for this vault to retry now.` : "Index has no recorded failure."}`,
      details,
    };
  }
  if (input.operation === "lint") {
    const lint = await lintMemoryWikiVault(config);
    const issues = lint.issues
      .slice(0, 5)
      .map((issue) => Object.assign({}, issue, { message: issue.message.slice(0, 160) }));
    return {
      text: `${identity.vaultName} (${identity.vaultId}): ${lint.issueCount} issues. ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`.slice(
        0,
        4_000,
      ),
      details: {
        ...identity,
        issueCount: lint.issueCount,
        issues,
        truncated: lint.issueCount > issues.length,
        reportPath: "reports/lint.md",
      },
    };
  }
  const mutation = input.mutation!;
  if (mutation.op === "refresh") {
    await compileMemoryWikiVault(config);
    return {
      text: `Rebuilt ${identity.vaultName} (${identity.vaultId}). Search and links are current.`,
      details: { ...identity, operation: "refresh", indexesRefreshed: true },
    };
  }
  let saved;
  if (mutation.op === "create") {
    saved = await createMemoryWikiDocument({
      config,
      title: mutation.title ?? "",
      content: mutation.body ?? "",
    });
  } else {
    const document = await getMemoryWikiDocument({ config, lookup: mutation.lookup ?? "" });
    if (!document?.editMode) {
      throw new MemoryWikiEditValidationError(
        "This document is not editable. Read its current edit permissions before changing it.",
      );
    }
    saved = await saveMemoryWikiDocument({
      config,
      path: document.path,
      editMode: document.editMode,
      content: mutation.body ?? "",
      expectedRevision: mutation.expectedRevision ?? "",
      ...(mutation.title === undefined ? {} : { title: mutation.title }),
    });
  }
  return {
    text: `${saved.saved ? "Saved" : "Unchanged"} ${saved.path} in ${identity.vaultName}. Version: ${saved.revision}. ${saved.indexesRefreshed ? "Search and links are current." : "Source saved; index rebuild failed. Last successful index retained and retry scheduled. Refresh this vault to retry now."}`,
    details: { ...identity, ...saved, operation: mutation.op },
  };
}

/** The model selects a Wiki target; its owner selects storage, ACLs, and write semantics. */
export async function runWikiOperation(
  config: ResolvedMemoryWikiConfig,
  appConfig: OpenClawConfig | undefined,
  input: MemoryWikiOperation,
) {
  if (input.vaultId && input.vaultName) {
    return {
      content: [{ type: "text" as const, text: "Choose vaultId or vaultName, never both." }],
      details: { error: "invalid-target" },
    };
  }
  const results: MemoryWikiOperationResult[] = [];
  const personalId = `personal:${input.agentId ?? config.agentId ?? "main"}`;
  try {
    const personalSelected =
      input.vaultId === personalId ||
      (!input.vaultId &&
        !input.vaultName &&
        (await resolveMemoryCorpusScope(input)).personalWikiEnabled);
    if (personalSelected) {
      results.push(await runPersonalOperation(config, appConfig, input));
    }
  } catch (error) {
    const message =
      error instanceof MemoryWikiEditValidationError || error instanceof MemoryWikiEditConflictError
        ? error.message.slice(0, 500)
        : "Personal Wiki operation could not be completed. Read its status and the document before retrying; any saved source remains authoritative.";
    results.push({ text: message, details: { vaultId: personalId, error: message } });
  }
  if (input.vaultId !== personalId) {
    results.push(...(await runMemoryWikiSupplementOperation(input)));
  }
  if (!results.length) {
    results.push({
      text: "No enabled Wiki is available for this request. Select an accessible Wiki in Wiki Hub, or use its exact returned vaultId.",
      details: { error: "wiki-unavailable" },
    });
  }
  return {
    content: [
      {
        type: "text" as const,
        text: results
          .map((result) => result.text)
          .join("\n\n")
          .slice(0, 4_000),
      },
    ],
    details:
      !input.vaultId && !input.vaultName
        ? { scope: "enabled", checkedOwners: results.length }
        : results.length === 1
          ? results[0]!.details
          : { error: "wiki-unavailable" },
  };
}
