import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function readCredentialFlowAction(
  details: unknown,
): { requestId: string; targetKey: string } | null {
  const action = asRecord(asRecord(details)?.uiAction);
  if (
    !action ||
    Object.keys(action).length !== 5 ||
    action.version !== 1 ||
    action.kind !== "settings" ||
    action.feature !== "platformclaw.exec-credentials" ||
    typeof action.requestId !== "string" ||
    !UUID_RE.test(action.requestId) ||
    typeof action.targetKey !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(action.targetKey)
  ) {
    return null;
  }
  return { requestId: action.requestId, targetKey: action.targetKey };
}

export type CredentialDefinition = { envName: string; definitionToken: string };
export type PersonalCredentialDefinition = CredentialDefinition & {
  configured: boolean;
  credentialToken: string | null;
  revision?: number;
  updatedAt?: number;
};
export type CredentialDraft = {
  definitionToken: string;
  credentialToken: string | null;
  value: string;
  conflict: boolean;
  message: string;
  error: string;
};
export type CredentialSelection = {
  search: string;
  status: "all" | "saved" | "missing" | "drafts";
  page: number;
  selected: string | null;
  picking: boolean;
};
export type CredentialCatalogRow = CredentialDefinition & {
  configured: boolean;
  dirty: boolean;
  conflict: boolean;
  error: boolean;
  pending?: boolean;
};

export function createCredentialSelection(): CredentialSelection {
  return { search: "", status: "all", page: 0, selected: null, picking: false };
}

export function createCredentialDraft(item: PersonalCredentialDefinition): CredentialDraft {
  return {
    definitionToken: item.definitionToken,
    credentialToken: item.credentialToken,
    value: "",
    conflict: false,
    message: "",
    error: "",
  };
}

export function readCredentialDefinitions(value: unknown): CredentialDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error("invalid credential metadata");
  }
  return value.map((entry) => {
    const item = asRecord(entry);
    if (typeof item?.envName !== "string" || typeof item.definitionToken !== "string") {
      throw new Error("invalid credential metadata");
    }
    return { envName: item.envName, definitionToken: item.definitionToken };
  });
}

export function readPersonalCredentialDefinitions(value: unknown): PersonalCredentialDefinition[] {
  const definitions = readCredentialDefinitions(value);
  return definitions.map((definition, index) => {
    const item = asRecord((value as unknown[])[index])!;
    if (
      typeof item.configured !== "boolean" ||
      (item.credentialToken !== null && typeof item.credentialToken !== "string")
    ) {
      throw new Error("invalid personal credential metadata");
    }
    return {
      envName: definition.envName,
      definitionToken: definition.definitionToken,
      configured: item.configured,
      credentialToken: item.credentialToken,
      revision: Number.isSafeInteger(item.revision) ? (item.revision as number) : undefined,
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : undefined,
    };
  });
}

export function selectCredentialCatalogPage(
  rows: CredentialCatalogRow[],
  selection: CredentialSelection,
) {
  const query = selection.search.trim().toLocaleLowerCase();
  const filtered = rows.filter(
    (row) =>
      (!query || row.envName.toLocaleLowerCase().includes(query)) &&
      (selection.status === "all" ||
        (selection.status === "saved"
          ? row.configured
          : selection.status === "missing"
            ? !row.configured
            : row.dirty)),
  );
  const page = Math.min(selection.page, Math.max(0, Math.ceil(filtered.length / 8) - 1));
  const start = page * 8;
  return { filtered, page, start, visible: filtered.slice(start, start + 8) };
}
