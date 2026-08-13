import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { JiraVocConfig } from "./browser-voc-http.js";

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Jira VOC config ${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredString(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Jira VOC config ${field} must be an array`);
  }
  return [...new Set(value.map((entry) => requiredString(entry, `${field} entry`)))];
}

export function parseJiraVocConfig(raw: string): JiraVocConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error("Jira VOC config must contain valid JSON", { cause: error });
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error("Jira VOC config must be an object");
  }
  const baseUrl = new URL(requiredString(record.baseUrl, "baseUrl"));
  if (
    (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error("Jira VOC config baseUrl must be an HTTP(S) URL without credentials");
  }
  return {
    baseUrl: baseUrl.toString().replace(/\/$/u, ""),
    projectKey: requiredString(record.projectKey, "projectKey"),
    ...(optionalString(record.parentIssueKey, "parentIssueKey")
      ? { parentIssueKey: optionalString(record.parentIssueKey, "parentIssueKey") }
      : {}),
    issueType: requiredString(record.issueType, "issueType"),
    ...(optionalString(record.assignee, "assignee")
      ? { assignee: optionalString(record.assignee, "assignee") }
      : {}),
    components: stringArray(record.components, "components"),
    ...(optionalString(record.coworkerField, "coworkerField")
      ? { coworkerField: optionalString(record.coworkerField, "coworkerField") }
      : {}),
    defaultCoworkers: stringArray(record.defaultCoworkers, "defaultCoworkers"),
    authorization: requiredString(record.authorization, "authorization"),
  };
}
